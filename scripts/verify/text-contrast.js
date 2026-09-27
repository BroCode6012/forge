#!/usr/bin/env node
/**
 * text-contrast.js — proves the pixel linter can still see the defect that
 * shipped on 2026-08-05: cream text on a cream card.
 *
 * The textual anti-slop checker owns a `low-contrast-on-video` rule, and it is
 * structurally incapable of catching that one. It compares a colour and a
 * background written in the SAME CSS block, and real compositions never do
 * that — the card declares the background, a child declares the text, and a
 * wrapper in between declares a wash that changes both. Only the rendered page
 * knows what colour ends up behind a word. So the check lives in the browser
 * pass, and this file is what stops it from rotting there.
 *
 * TWO THINGS ARE GUARDED, and the second is the subtle one.
 *
 * 1. The measurement itself, asserted in both directions. Firing on unreadable
 *    type is easy; NOT firing on a translucent plate, a gradient, or display
 *    type that is merely low-key is what keeps the rule switched on. A checker
 *    that argues with correct design gets disabled within a week.
 *
 * 2. That the harness resolves the theme's own colours. The lint page used to
 *    define no `--hf-*` variables at all, so `background: var(--hf-surface)`
 *    came out fully transparent and `color: var(--hf-text)` came out the
 *    browser's default black. Geometry checks survived that; a contrast check
 *    cannot — and the art-director vision review had been grading screenshots
 *    painted in the wrong palette the whole time. The var-only cases below are
 *    the tripwire: they can only behave correctly if the theme really resolves.
 *
 * Needs headless Chrome. Skips loudly (exit 0) without it, exactly as the
 * module itself fails open — a machine with no browser must not turn a green
 * gate red, but it must also not pretend it verified anything.
 *
 * Kill switch: HF_TEXT_CONTRAST_VERIFY=0
 */
'use strict';

const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const RENDER = path.join(ROOT, 'src', 'render');
const { visualLint, closeVisualLint, CONTRAST, themeCssVars } = require(path.join(RENDER, 'hf-visual-lint'));
const { VIDEO } = require(path.join(RENDER, 'hf-slop-lint'));
const { themeVarPalette } = require(path.join(RENDER, 'hf-author-repair'));
const { getThemeTokens } = require(path.join(ROOT, 'src', 'data', 'themes'));

if (String(process.env.HF_TEXT_CONTRAST_VERIFY || '').trim() === '0') {
    console.log('text-contrast: SKIPPED (HF_TEXT_CONTRAST_VERIFY=0)');
    process.exit(0);
}

let failed = 0;
function fail(msg) { console.error(`\n  FAIL  ${msg}\n`); failed++; process.exitCode = 1; }
function ok(msg) { console.log(`    · ${msg}`); }

// ── The floors must stay the checker's, not this file's ────────────────────
//
// Browser-free and cheap. If someone hardcodes 4.5 into the in-page pass, the
// two copies drift the first time the anti-slop thresholds are tuned and the
// pixel check starts enforcing a floor nobody chose.
if (!CONTRAST) {
    fail('hf-visual-lint no longer exports CONTRAST — the contrast pass cannot be verified');
} else {
    if (CONTRAST.minBody !== VIDEO.CONTRAST_MIN_BODY || CONTRAST.minDisplay !== VIDEO.CONTRAST_MIN_DISPLAY) {
        fail(`the pixel pass has its own floors (${CONTRAST.minBody}/${CONTRAST.minDisplay}) instead of the checker's (${VIDEO.CONTRAST_MIN_BODY}/${VIDEO.CONTRAST_MIN_BODY}) — two copies of a threshold always drift`);
    } else ok(`floors come from the anti-slop checker: body ${CONTRAST.minBody}:1, display ${CONTRAST.minDisplay}:1`);

    if (CONTRAST.displayPx !== VIDEO.DISPLAY_SIZE_PX) {
        fail(`the display/body split (${CONTRAST.displayPx}px) no longer matches the checker's own display size (${VIDEO.DISPLAY_SIZE_PX}px)`);
    }
    if (!(CONTRAST.minDisplay < CONTRAST.minBody)) {
        fail('display type is not getting the looser floor — big type is legible at ratios that would bury body copy, and a single floor flags correct headline design');
    }
    if (!(CONTRAST.minBackdropAlpha > 0.5 && CONTRAST.minBackdropAlpha <= 1)) {
        fail(`the backdrop opacity floor (${CONTRAST.minBackdropAlpha}) is not a sane share — below ~0.5 the rule starts judging text that is really sitting on live footage`);
    }
}

// ── The two copies of the theme wiring must agree ──────────────────────────
//
// The repair pass substitutes off-theme colours using its own parsed palette;
// this pass measures the rendered pixels using its own CSS block. They are
// duplicated on purpose — importing one into the other closes a require cycle
// through hf-design-doc. Duplicated means they can drift, and drift here is
// vicious: a repair would swap in one colour while the contrast check measured
// another, so a composition could be "fixed" into something unreadable.
const VAR_KEYS = ['--hf-primary', '--hf-accent', '--hf-text', '--hf-muted', '--hf-surface', '--hf-bg'];

function parseBlock(block) {
    const out = {};
    for (const decl of String(block).split(';')) {
        const i = decl.indexOf(':');
        if (i < 0) continue;
        out[decl.slice(0, i).trim()] = decl.slice(i + 1).trim();
    }
    return out;
}

/** '#1a2b3c' | 'rgb(...)' | '{r,g,b}' → a comparable rgb triple. */
function norm(v) {
    if (v && typeof v === 'object') return [v.r, v.g, v.b].map(n => Math.round(n)).join(',');
    const s = String(v || '').trim().toLowerCase();
    let m = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
    if (m) {
        const h = m[1].length === 3 ? m[1].split('').map(c => c + c).join('') : m[1];
        return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)).join(',');
    }
    m = s.match(/rgba?\(([^)]+)\)/);
    if (m) {
        const p = m[1].split(/[,\s/]+/).filter(Boolean).map(x => Math.round(parseFloat(x)));
        return p.slice(0, 3).join(',');
    }
    return s;
}

for (const themeId of ['crime', 'warm-editorial', 'luxury', 'nature', 'minimal', 'modern']) {
    const theme = getThemeTokens(themeId);
    const block = parseBlock(themeCssVars(themeId));
    const palette = new Map((themeVarPalette(theme) || []).map(e => [e.varName, e.color]));
    if (!Object.keys(block).length) {
        fail(`themeCssVars('${themeId}') produced nothing — the lint harness would render that theme colour-blind`);
        continue;
    }
    const missing = VAR_KEYS.filter(k => block[k] == null);
    if (missing.length) {
        fail(`the lint harness does not define ${missing.join(', ')} on ${themeId} — any composition using those variables would be measured against a transparent backdrop and silently escape the check`);
    }
    const drift = VAR_KEYS.filter((k) => {
        const a = block[k];
        const b = palette.get(k);
        if (a == null || b == null) return false;   // one side may not track a var
        return norm(a) !== norm(b);
    });
    if (drift.length) {
        fail(`the two copies of the theme wiring disagree on ${themeId}: ${drift.map(k => `${k} is ${block[k]} for the pixel check but rgb(${norm(palette.get(k))}) for the repair`).join('; ')} — a repair would substitute one colour while the contrast check measured another`);
    } else if (!missing.length) {
        ok(`${themeId}: repair palette and lint harness resolve the same colours`);
    }
}

// ── Fixtures ───────────────────────────────────────────────────────────────
//
// One card, one headline, one body line — the exact shape of the graphic that
// shipped the defect. Only the colours change between cases.

const TL = 'gsap.set(".tc-card", { opacity: 0, y: 40 });\n'
    + 'tl.to(".tc-card", { opacity: 1, y: 0, duration: 0.6 }, 0);\n';

const HTML = '<div class="tc-card">'
    + '<p class="tc-h">Winter On The Ridge</p>'
    + '<p class="tc-b">The last road out closed before dawn.</p></div>';

const BASE = '.tc-card { position:absolute; left:200px; top:220px; width:1200px; padding:60px; }\n'
    + '.tc-h { font-size: 72px; line-height: 1.05; margin:0 0 24px; }\n'
    + '.tc-b { font-size: 34px; line-height: 1.4; margin:0; }\n';

async function run(css, themeId) {
    const res = await visualLint({ html: HTML, css, timeline: TL }, 'tc', 4, { kind: 'fullscreen', themeId });
    if (res.skipped) return null;
    return res.errors.filter(e => /unreadable/.test(e));
}

(async () => {
    const probe = await run(BASE + '.tc-card { background: #0a0a0a; }\n', 'crime');
    if (probe === null) {
        console.log('text-contrast: SKIPPED — headless Chrome unavailable, so the pixel rule could not be exercised');
        console.log('    (the module fails open the same way; this is a capability gap, not a pass)');
        await closeVisualLint();
        process.exit(failed ? 1 : 0);
    }

    const cases = [
        // [label, css, themeId, mustFire, why this case exists]
        ['cream type on a cream card',
            BASE + '.tc-card { background: #ece0c8; }\n.tc-h, .tc-b { color: #f7f1e5; }\n',
            'warm-editorial', true,
            'THE defect this rule exists for — the two colours live in different blocks, so nothing textual can pair them'],

        ['the same cream card with the theme\'s real ink',
            BASE + '.tc-card { background: #ece0c8; }\n.tc-h, .tc-b { color: #2c2218; }\n',
            'warm-editorial', false,
            'a light theme done correctly must never be flagged, or the rule gets switched off'],

        ['theme background colour used as type on the theme surface',
            BASE + '.tc-card { background: var(--hf-surface); }\n.tc-h, .tc-b { color: var(--hf-bg); }\n',
            'warm-editorial', true,
            'TRIPWIRE — var()-only. If the harness stopped resolving the theme this would measure transparent and quietly pass'],

        ['theme ink on the theme surface',
            BASE + '.tc-card { background: var(--hf-surface); }\n.tc-h, .tc-b { color: var(--hf-text); }\n',
            'warm-editorial', false,
            'TRIPWIRE — the pairing every authored composition is told to use must always pass'],

        ['a translucent plate over live footage',
            BASE + '.tc-card { background: rgba(236,224,200,0.40); }\n.tc-h, .tc-b { color: #f7f1e5; }\n',
            'warm-editorial', false,
            'the real backdrop is the editor\'s clip and is unknowable here — claiming either way would be inventing evidence'],

        ['a gradient backdrop',
            BASE + '.tc-card { background: linear-gradient(180deg,#ece0c8,#8a7a5c); }\n.tc-h, .tc-b { color: #f7f1e5; }\n',
            'warm-editorial', false,
            'a gradient has no single colour to measure against'],

        ['a translucent wash over an opaque card',
            BASE + '.tc-card { background: #1a1a1a; }\n'
            + '.tc-h { background: rgba(240,236,228,0.92); color: #d9d2c4; }\n',
            'crime', true,
            'composited the stack is still opaque, so it IS knowable — this is the case a naive one-level check misses'],

        ['display type just over the looser floor',
            BASE + '.tc-card { background: #0a0a0a; }\n.tc-h { color: #7a7a7a; }\n.tc-b { color: #ffffff; }\n',
            'crime', false,
            'low-key headline treatment is a real design choice — flagging it would mean the display floor is being ignored'],

        ['a composition that states no colour at all',
            BASE + '.tc-card { background: #0a0a0a; }\n',
            'crime', false,
            'at render time it inherits the theme ink from the .hf-mg wrapper — if the harness stops mirroring that, every such composition gets falsely condemned as black-on-black'],
    ];

    for (const [label, css, themeId, mustFire, why] of cases) {
        const hits = await run(css, themeId);
        if (hits === null) continue;
        if (mustFire && !hits.length) {
            fail(`${label}: nothing was flagged — ${why}`);
        } else if (!mustFire && hits.length) {
            fail(`${label}: flagged "${hits[0].slice(0, 140)}" — ${why}`);
        } else {
            ok(`${label}: ${mustFire ? `caught — ${hits[0].replace(/^text /, '').slice(0, 96)}` : 'left alone'}`);
        }
    }

    await closeVisualLint();

    if (!failed) {
        console.log(`text-contrast: OK — unreadable type is measured from the rendered pixels (body ${CONTRAST.minBody}:1, display ${CONTRAST.minDisplay}:1) with the theme's own colours resolved, and correct design is left alone`);
    }
    process.exit(failed ? 1 : 0);
})().catch(async (err) => {
    // An unexpected throw is a real failure — unlike a missing browser, which
    // is handled above.
    console.error(`\n  FAIL  text-contrast threw: ${err && err.stack ? err.stack : err}\n`);
    try { await closeVisualLint(); } catch (_) { /* noop */ }
    process.exit(1);
});
