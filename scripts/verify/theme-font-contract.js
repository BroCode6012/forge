#!/usr/bin/env node
/**
 * VERIFY: a theme can never again hand the composition author a font that the
 * slop checker rejects, or a font the render browser cannot draw.
 *
 * The failure this pins (2026-08-04 build, log app-2026-08-04T21-03-06):
 *
 *     ✗ overused-font: font-family: lato — this face is in every generated
 *       design; it reads as a default, not a choice.
 *       hint: use the theme faces instead (heading "Playfair Display",
 *             body "Lato, Source Sans Pro, Open Sans, sans-serif")
 *     ... 11 authored graphics rejected this way in one build ...
 *
 * Read that hint again: the rule rejected Lato and then told the author to use
 * Lato, because the theme's own body face WAS Lato. Three separate systems each
 * held part of the truth and none of them compared notes:
 *
 *   1. `hf-slop-lint.js` bans the monoculture faces (Lato, Montserrat, Open
 *      Sans, Inter, Roboto…). Correct — that list is the whole point of the
 *      anti-slop work.
 *   2. `data/themes.js` shipped those exact faces as the declared body/heading
 *      font of `standard`, `warm-editorial`, `luxury` and `nature`. Also
 *      "correct" in isolation; nobody had told it the ban existed.
 *   3. `hyperframes-bridge.js:buildFontFaces` can only embed faces that have a
 *      file in `assets/fonts/`, because THE RENDER BROWSER HAS NO NETWORK. A
 *      theme naming a font with no file renders in a fallback face and nothing
 *      reports it — `history` and `minimal` both asked for Lora, which was not
 *      on disk, and quietly got something else in every video ever made.
 *
 * So there were two distinct silent defects: designs rejected for obeying the
 * theme, and designs rendered in a font nobody chose. Neither shows up as an
 * error in a build log. Both cost real AI money — every rejection burns an
 * author repair round.
 *
 * The property that makes it impossible now: this gate does not restate any of
 * the three rules. It IMPORTS the checker's real ban list, RUNS the real
 * `slopLint` rule against every theme's real declared stacks, and derives the
 * on-disk families using the bridge's OWN filename regex sliced out of the
 * bridge source. Adding a face to the ban list, renaming a font file, or
 * changing a theme all fail here immediately, because there is only one copy of
 * each fact and this gate reads all three.
 *
 * Weight coverage is the third silent defect and is enforced the same way. Every
 * theme asked for weight 900 headings from a flat constant that never looked at
 * the font: Oswald's heaviest real cut is 700, Bebas Neue only exists at 400.
 * The browser does not fail on that — it smears the outlines it has to fake a
 * heavier face, and synthetic bold is exactly the kind of tell that makes
 * generated video read as generated. A crisp real 700 beats a faked 900, so a
 * theme now declares the weight its family actually ships and this gate fails if
 * that weight has no file.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const FONT_DIR = path.join(ROOT, 'assets', 'fonts');
const BRIDGE_PATH = path.join(ROOT, 'src', 'render', 'hyperframes-bridge.js');

let failures = 0;
let checks = 0;

function check(label, condition, detail) {
    checks++;
    if (condition) {
        console.log(`  ok   ${label}`);
    } else {
        failures++;
        console.log(`  FAIL ${label}`);
        if (detail) console.log(`       ${detail}`);
    }
}

console.log('[verify] theme font contract');

// ---------------------------------------------------------------------------
// The three sources of truth, loaded rather than restated
// ---------------------------------------------------------------------------
const { slopLint, OVERUSED_FONTS } = require('../../src/render/hf-slop-lint');
const THEMES = require('../../src/data/themes');

check(
    'the checker still exposes its ban list for the theme contract to read',
    OVERUSED_FONTS instanceof Set && OVERUSED_FONTS.size > 0,
    'OVERUSED_FONTS is no longer exported or is empty — without it this gate '
    + 'would have to keep its own copy of the list, which is exactly how the '
    + 'two rules drifted apart in the first place'
);

// ---------------------------------------------------------------------------
// What the render browser can actually draw, derived with the BRIDGE's own rule
//
// Duplicating the filename convention here would let the gate bless a font the
// bridge silently skips, so pull the real regex and the real special-case map
// out of hyperframes-bridge.js and use those.
// ---------------------------------------------------------------------------
const bridgeSrc = fs.readFileSync(BRIDGE_PATH, 'utf8');
const reMatch = /base\.match\((\/\^\(\[A-Za-z\]\+\)[^\n]*?\/)\)/.exec(bridgeSrc);
const specialMatch = /const SPECIAL = (\{[^}]*\})/.exec(bridgeSrc);
const extMatch = /if \(!(\/\\\.\([^\n]*?\/i)\.test\(file\)\) continue;/.exec(bridgeSrc);

check(
    "the bridge's font-naming rule is still readable from here",
    Boolean(reMatch && specialMatch && extMatch),
    'could not slice the filename regex / SPECIAL map / extension filter out of '
    + 'buildFontFaces(). If the naming scheme moved, this gate must move with it '
    + 'or it will start approving fonts that never get embedded'
);

/** family name -> Set of weights available on disk */
const onDisk = new Map();
if (reMatch && specialMatch && extMatch) {
    // eslint-disable-next-line no-eval
    const NAME_RE = eval(reMatch[1]);
    // eslint-disable-next-line no-eval
    const EXT_RE = eval(extMatch[1]);
    // eslint-disable-next-line no-eval
    const SPECIAL = eval(`(${specialMatch[1]})`);

    for (const file of fs.readdirSync(FONT_DIR)) {
        if (!EXT_RE.test(file)) continue;
        const base = file.replace(/\.(woff2?|ttf|otf)$/i, '');
        const m = base.match(NAME_RE);
        if (!m) continue;
        const family = (SPECIAL[m[1]] || m[1].replace(/([a-z])([A-Z])/g, '$1 $2')).toLowerCase();
        const weight = /^\d{3}$/.test(m[2] || '') ? Number(m[2]) : 400;
        if (!onDisk.has(family)) onDisk.set(family, new Set());
        onDisk.get(family).add(weight);
    }
}

check(
    'the embeddable font set is non-empty',
    onDisk.size > 0,
    'no font file in assets/fonts parsed into a family — every theme would '
    + 'render in a browser default and the whole typography system is inert'
);

// ---------------------------------------------------------------------------
// How the checker picks the face it judges — asked of the checker, not guessed
//
// The rule reads the first non-generic entry in the stack. Rather than
// reimplementing "non-generic", probe the real rule: a stack is only clean if
// slopLint says so.
// ---------------------------------------------------------------------------
function overusedHits(stack) {
    const css = `.probe { font-family: ${stack}; }`;
    const res = slopLint({ html: '', css, timeline: '' }, { only: ['overused-font'] });
    return res.findings.filter(f => f.id === 'overused-font');
}

// The first entry the browser will actually try. Generic families are the
// browser's own last resort and are never embedded, so they end the search.
const GENERIC = new Set([
    'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
    'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded',
    '-apple-system', 'blinkmacsystemfont', 'segoe ui',
]);
function primaryOf(stack) {
    return String(stack || '')
        .split(',')
        .map(s => s.trim().replace(/^['"]|['"]$/g, '').toLowerCase())
        .filter(Boolean)
        .find(f => !GENERIC.has(f) && !f.startsWith('var('));
}

// ---------------------------------------------------------------------------
// Prove the gate can fail before trusting it to pass
// ---------------------------------------------------------------------------
{
    const banned = [...OVERUSED_FONTS][0];
    check(
        'a banned face in a theme stack really is detected',
        overusedHits(`"${banned}", Georgia, serif`).length === 1,
        `a stack led by "${banned}" produced no finding — every theme check `
        + 'below would then pass without testing anything'
    );
    check(
        'a clean face in a theme stack really is allowed',
        overusedHits('"Playfair Display", Georgia, serif').length === 0,
        'the rule flags a face that is not on the ban list, so it would reject '
        + 'every possible theme and the gate is measuring nothing'
    );
    check(
        'a font with no file on disk really is detected as unrenderable',
        !onDisk.has('a font that does not exist'),
        'the disk index claims to contain a font that cannot exist'
    );
    // The weight check is only meaningful if the index distinguishes weights at
    // all. If every family collapsed to one entry the weight rows would always
    // be empty and that check would pass while measuring nothing.
    const weighted = [...onDisk.values()].filter(w => w.size > 1).length;
    check(
        'the disk index really does separate weights within a family',
        weighted > 0,
        'no family on disk resolved to more than one weight, so the weight '
        + 'check below cannot fail no matter what a theme declares'
    );
}

// ---------------------------------------------------------------------------
// Every theme, every slot
// ---------------------------------------------------------------------------
const SLOTS = [
    ['headingFont', 'headingWeight'],
    ['bodyFont', 'bodyWeight'],
    ['captionFont', 'captionWeight'],
    ['statFont', 'statWeight'],
];

const themeIds = THEMES.getThemeIds();
check(
    'the theme registry still lists themes to check',
    Array.isArray(themeIds) && themeIds.length > 0,
    'getThemeIds() returned nothing; the loop below would pass vacuously'
);

const bannedRows = [];
const missingRows = [];
const weightRows = [];

for (const id of themeIds) {
    const tokens = THEMES.getThemeTokens(id);
    const typo = (tokens && tokens.typography) || {};
    for (const [fontKey, weightKey] of SLOTS) {
        const stack = typo[fontKey];
        if (!stack) continue;

        if (overusedHits(stack).length > 0) {
            bannedRows.push(`${id}.${fontKey} = ${primaryOf(stack)}`);
        }

        const primary = primaryOf(stack);
        if (!primary) {
            missingRows.push(`${id}.${fontKey} — stack has no real face at all`);
        } else if (!onDisk.has(primary)) {
            // A stack whose primary has no file is not automatically broken —
            // the browser walks to the next entry. It IS broken if nothing in
            // the stack is embeddable, and misleading either way, so report the
            // first case and fail the second.
            const rescue = String(stack).split(',')
                .map(s => s.trim().replace(/^['"]|['"]$/g, '').toLowerCase())
                .find(f => onDisk.has(f));
            missingRows.push(
                `${id}.${fontKey} — "${primary}" has no file in assets/fonts`
                + (rescue ? ` (would silently render as "${rescue}")` : ' (renders as a browser default)')
            );
        } else {
            const want = Number(typo[weightKey] || 400);
            const have = onDisk.get(primary);
            if (!have.has(want)) {
                const nearest = [...have].sort((a, b) => Math.abs(a - want) - Math.abs(b - want))[0];
                weightRows.push(`${id}.${fontKey} asks ${want}, only ${[...have].sort().join('/')} on disk (renders ${nearest} + fake bold)`);
            }
        }
    }
}

check(
    'no theme ships a face the anti-slop checker bans',
    bannedRows.length === 0,
    `${bannedRows.length} slot(s) name a banned face:\n       `
    + bannedRows.join('\n       ')
    + '\n       Every graphic built on these themes is rejected for obeying its '
    + 'own theme, and each rejection burns an AI repair round.'
);

check(
    'every theme face has a font file the render browser can embed',
    missingRows.length === 0,
    `${missingRows.length} slot(s) name a font with no file:\n       `
    + missingRows.join('\n       ')
    + '\n       The render browser has no network, so these render in some other '
    + 'face with nothing in the log to say so.'
);

check(
    'every theme asks for a weight its own font family actually ships',
    weightRows.length === 0,
    `${weightRows.length} slot(s) request a weight with no file:\n       `
    + weightRows.join('\n       ')
    + '\n       The browser fakes the missing weight by smearing the face it has. '
    + 'Either add the real cut to assets/fonts, or declare the weight the family '
    + 'genuinely tops out at in that theme\'s fonts block (headingWeight / '
    + 'bodyWeight / captionWeight).'
);

// ---------------------------------------------------------------------------
// Variety: the fix for a monoculture must not be a smaller monoculture
// ---------------------------------------------------------------------------
{
    const bodies = themeIds
        .map(id => primaryOf(((THEMES.getThemeTokens(id) || {}).typography || {}).bodyFont))
        .filter(Boolean);
    const distinct = new Set(bodies).size;
    check(
        'the themes do not all collapse onto one body face',
        distinct >= Math.min(4, themeIds.length),
        `${themeIds.length} themes share only ${distinct} body face(s): `
        + `${[...new Set(bodies)].join(', ')} — replacing a banned monoculture `
        + 'with a house monoculture loses the same variety the ban exists to protect'
    );
}

// ---------------------------------------------------------------------------
// The fourth system: what the composition AUTHOR is told
//
// The three above cover what the theme declares, what the checker bans and what
// the browser can embed. They all agreed and the author still lost compositions
// to the font rule, because none of them governs the DESIGN BRIEF.
//
// A font stack is a fallback chain, but the author reads it as a menu. The
// overused-font rule only judges the PRIMARY face, so `"Barlow Condensed",
// Lato, Arial, sans-serif` passes every check above — and then the brief hands
// that whole string over, the author picks a name out of the middle, and the
// composition is rejected for a rule it was shown no list for. One repair round
// later it falls back to the built-in card, which is the generic look this
// whole effort exists to kill. Silent, and it costs two AI calls per graphic.
//
// So: the brief must name no banned face anywhere in a stack, and must state
// the ban list outright.
// ---------------------------------------------------------------------------
{
    const { generateDesignDoc } = require('../../src/render/hf-design-doc');
    const STACK_RE = /^- (?:Headings|Body|Numbers\/stats): (.+?) — weight/gm;
    const stacksOf = (doc) => [...doc.matchAll(STACK_RE)].map(m => m[1].trim());
    const facesOf = (stack) => stack.split(',').map(p => p.trim().replace(/^["']|["']$/g, '').toLowerCase());

    // Anti-vacuity FIRST. Every assertion below is "no banned face was found",
    // which is also what a parser that matches nothing reports. If the brief's
    // wording changes, this fails loudly instead of going quietly green.
    const probe = generateDesignDoc({ themeId: 'standard' });
    check(
        'the design brief still states its fonts in a shape this gate can read',
        stacksOf(probe).length === 3,
        `found ${stacksOf(probe).length} font stack(s) in the brief, expected 3 `
        + '(headings, body, numbers/stats) — the Typography block was reworded, so '
        + 'every font assertion below is now inspecting an empty list and passing '
        + 'for the wrong reason. Re-point STACK_RE at the new wording.'
    );

    // The real work: a theme whose raw chain DOES contain a banned face must
    // still brief a clean one. Without this, the gate would pass simply because
    // the themes happen to be tidy, and deleting the filter would go unnoticed.
    const dirty = themeIds
        .map(id => ({ id, raw: ((THEMES.getThemeTokens(id) || {}).typography || {}) }))
        .filter(({ raw }) => [raw.headingFont, raw.bodyFont, raw.statFont]
            .filter(Boolean).some(s => facesOf(s).some(f => OVERUSED_FONTS.has(f))));
    check(
        'a theme that legitimately lists a banned fallback is still briefed cleanly',
        dirty.length > 0 && dirty.every(({ id }) => !stacksOf(generateDesignDoc({ themeId: id }))
            .some(s => facesOf(s).some(f => OVERUSED_FONTS.has(f)))),
        dirty.length === 0
            ? 'no theme currently lists a banned face anywhere in a fallback chain, so '
              + 'this gate proved nothing. That is not a pass: the filter in '
              + 'hf-design-doc.js could be deleted and nothing here would notice. '
              + 'Keep a real dirty stack, or assert the filter directly.'
            : `briefed a banned face for: ${dirty.map(d => d.id).join(', ')} — the `
              + 'author-facing stack filter in hf-design-doc.js is not running'
    );

    // Every theme, plus an id that resolves to nothing — the unknown-theme path
    // is where the old hardcoded 'Inter, sans-serif' fallback used to surface,
    // and Inter is itself on the ban list.
    const leaks = [];
    for (const id of [...themeIds, '__no_such_theme__']) {
        for (const stack of stacksOf(generateDesignDoc({ themeId: id }))) {
            const bad = facesOf(stack).filter(f => OVERUSED_FONTS.has(f));
            if (bad.length) leaks.push(`${id}: "${stack}" names ${bad.join(', ')}`);
        }
    }
    check(
        'no theme briefs the author a face the checker will reject',
        leaks.length === 0,
        `${leaks.length} stack(s) hand the author a banned face:\n       `
        + leaks.join('\n       ')
        + '\n       The author will copy one of these and lose the composition.'
    );

    const brief = generateDesignDoc({ themeId: 'standard' });
    check(
        'the brief names the banned faces instead of leaving the author to guess',
        [...OVERUSED_FONTS].every(f => brief.toLowerCase().includes(f)),
        'the design brief does not list every banned face. The author writes CSS '
        + 'blind: a rule it is never shown is a rule it will break, and each break '
        + 'costs a repair round and then a fallback to the built-in card.'
    );
}

console.log(`\n[verify] theme font contract: ${checks - failures}/${checks} passed`);
if (failures > 0) {
    console.error(`[verify] FAILED (${failures})`);
    process.exit(1);
}
