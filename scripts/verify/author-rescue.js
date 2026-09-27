#!/usr/bin/env node
/**
 * VERIFY: a composition is never thrown away over a defect that has exactly one
 * correct answer — and the author is told the rules it is judged by.
 *
 * The failure this pins (2026-08-04 build, log app-2026-08-04T21-03-06):
 * 26 rejection events across 18 graphics, and 12 of those graphics ran out of
 * their two rounds and fell back to the hardcoded built-in card. The causes:
 *
 *     ✗ side-tab: border-left: 3px solid var(--accent)          × 4
 *     ✗ pseudo-side-bar: 5px wide, 72px tall, filled            × 1
 *     ✗ tight-leading: line-height 0.7 on 72px display type     × 1
 *     ✗ timeline ends at 8.80s, after the 8.64s scene duration  × 3
 *     ✗ text sits below y=1000px (YouTube paints its controls)  × 2
 *
 * Every one of those is a single unambiguous edit, and every one of them cost a
 * whole bespoke design. Two things were wrong at once:
 *
 *   1. The author was never shown the rules. `side-tab`, `border-left`,
 *      `line-height` and the 80px safe zone appeared ZERO times in the prompt
 *      and zero times in the skill pack. A rule that lives only inside the
 *      checker is a rule the author will break, because it is writing CSS blind.
 *   2. Nothing repaired them. The overrun is rejected inside
 *      `validateComposition`, and the only timeline rewrite in the file
 *      (`normalizeAuthoredTimeline`) runs AFTER validation passes — so the
 *      rejection path had no repair at all, and burned a round instead.
 *
 * Two fixes, both proved here:
 *
 *   PREVENTION — `hf-design-doc.js` emits a "House rules" section built from
 *   the live rule objects (`SLOP_RULES.filter(r => r.brief)`) and the live
 *   safe-area constants (`TITLE_SAFE`, `VIDEO`). Nothing is restated, so a
 *   threshold can never be tightened in the checker while the brief goes on
 *   quoting the old number — which is exactly how the font rules drifted apart.
 *
 *   RECOVERY — `hf-author-repair.js` fixes the mechanical breaches in code
 *   BEFORE a round is spent, and each repair is verified against the live rule
 *   that rejected it. A repair that cannot be proved to have worked is dropped.
 *
 * WHAT THIS GATE WILL NOT LET ANYONE DO: quietly widen the repair pass into the
 * judgement calls. Text overlap, nothing-animates-in, transform ownership and
 * numbers-not-in-the-brief must still REJECT. Papering over those would ship a
 * worse composition while reporting success, which is worse than the fallback
 * card, and the last two checks here fail if any of them ever becomes repairable.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const AUTHOR_PATH = path.join(ROOT, 'src', 'render', 'hf-template-author.js');

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

console.log('[verify] author rescue + house rules');

const {
    slopLint, SLOP_RULES, RULE_BY_ID, VIDEO, OVERUSED_FONTS,
} = require('../../src/render/hf-slop-lint');
const { TITLE_SAFE } = require('../../src/render/hf-visual-lint');
const { generateDesignDoc } = require('../../src/render/hf-design-doc');
const { getThemeTokens } = require('../../src/data/themes');
const repair = require('../../src/render/hf-author-repair');
const author = require('../../src/render/hf-template-author');

const THEME = getThemeTokens('crime');

// ---------------------------------------------------------------------------
// 0. Anti-vacuity.
//
// Every assertion below reads something out of a live structure. If that
// structure stops existing in the shape the gate expects, most of these checks
// would go quiet rather than red — "no banned face was found" is also what a
// parser matching nothing reports. So prove the inputs parse first.
// ---------------------------------------------------------------------------

check(
    'the checker still exposes the rule objects the brief is built from',
    Array.isArray(SLOP_RULES) && SLOP_RULES.length > 0 && RULE_BY_ID instanceof Map,
    'SLOP_RULES / RULE_BY_ID are no longer exported — the House rules section '
    + 'would silently render empty and the author would go back to writing blind'
);

check(
    'the rendered-pixel safe box is still readable from here',
    TITLE_SAFE && Number.isFinite(TITLE_SAFE.bottomPx) && Number.isFinite(TITLE_SAFE.bottomLine),
    'hf-visual-lint no longer exports TITLE_SAFE, so the brief cannot quote the '
    + 'same numbers the pixel checker measures against'
);

const DOC = generateDesignDoc({ themeId: 'crime' });
const houseIdx = DOC.indexOf('## House rules');
const houseBlock = houseIdx >= 0
    ? DOC.slice(houseIdx, (() => {
        const next = DOC.indexOf('\n## ', houseIdx + 1);
        return next === -1 ? DOC.length : next;
    })())
    : '';
const houseBullets = houseBlock.split('\n').filter(l => l.trim().startsWith('- '));

check(
    'the House rules section still parses in the shape this gate reads',
    houseIdx >= 0 && houseBullets.length >= 4,
    `found ${houseBullets.length} bullet(s) under "## House rules". Every check `
    + 'below searches that block; if it stopped rendering they would all pass on '
    + 'an empty string'
);

// ---------------------------------------------------------------------------
// 1. PREVENTION — the author is shown the rules it is judged by.
// ---------------------------------------------------------------------------

const briefedRules = SLOP_RULES.filter(r => r && r.brief && r.severity === 'error');

check(
    'the rules that cost real compositions carry an author-facing line',
    ['side-tab', 'pseudo-side-bar', 'tight-leading']
        .every(id => RULE_BY_ID.has(id) && String(RULE_BY_ID.get(id).brief || '').trim()),
    'side-tab / pseudo-side-bar / tight-leading account for 6 of the 15 '
    + 'non-font rejections in the 2026-08-04 build and appeared nowhere in the '
    + 'prompt. Each one needs a `brief` on its rule object'
);

const missing = briefedRules.filter(r => !houseBlock.includes(r.brief.slice(0, 60)));
check(
    'every rule that has an author-facing line actually reaches the brief',
    missing.length === 0,
    `${missing.map(r => r.id).join(', ')} declare a brief that never gets emitted. `
    + 'Adding a `brief` to a rule must be all it takes — otherwise the next rule '
    + 'is written and silently never taught'
);

/**
 * Does `text` quote this exact measurement?
 *
 * The digit guard is not pedantry: a plain `includes('80px')` matches inside
 * "1080px", so a brief that had stopped quoting the real 80px safe zone still
 * looked correct because it mentioned the frame height. The whole point of
 * these checks is to catch a number that has drifted, and a substring match on
 * a bare number is precisely the check that cannot.
 */
function quotes(text, value, unit = '') {
    return new RegExp(`(?<![\\d.])${String(value).replace('.', '\\.')}${unit}(?![\\d.])`).test(text);
}

check(
    'the safe-zone numbers in the brief are the pixel checker\'s own',
    quotes(houseBlock, TITLE_SAFE.bottomPx, 'px')
    && quotes(houseBlock, TITLE_SAFE.bottomLine, 'px')
    && quotes(houseBlock, TITLE_SAFE.topPx, 'px')
    && quotes(houseBlock, TITLE_SAFE.edgePx, 'px'),
    'the brief quotes a safe-area number that TITLE_SAFE does not hold. Restating '
    + 'a threshold is how the author ends up obeying a rule that no longer exists '
    + 'while breaking the one that does'
);

// Checked against the RULE's own line rather than the whole block: the block
// mentions 48px twice for two different reasons, so a block-wide search would
// let the leading floor drift and still pass on the stripe rule's copy of it.
const leadingBrief = String((RULE_BY_ID.get('tight-leading') || {}).brief || '');
check(
    'the leading floors the author is given are the checker\'s own constants',
    quotes(leadingBrief, VIDEO.MIN_LEADING_DISPLAY)
    && quotes(leadingBrief, VIDEO.MIN_LEADING_BODY)
    && quotes(leadingBrief, VIDEO.DISPLAY_SIZE_PX, 'px'),
    `the tight-leading brief reads "${leadingBrief.slice(0, 90)}" — it quotes a `
    + 'number VIDEO does not hold, so the author is being told one floor and '
    + 'measured against another'
);

// ---------------------------------------------------------------------------
// 2. RECOVERY — each repair clears the live rule that rejected it.
//
// Each fixture below is the real CSS from a real rejection in that build, not an
// invented one. The `before.ok === false` assertion inside every case is the
// discrimination proof: a fixture the checker does not reject would make the
// "after" assertion pass for free.
// ---------------------------------------------------------------------------

const LINT_ALL = { theme: THEME, kind: 'fullscreen', source: 'composition' };

function lint(css, only) {
    return slopLint(
        { html: FIXTURE_HTML, css, timeline: FIXTURE_TL },
        { ...LINT_ALL, only: [only] }
    );
}

const FIXTURE_HTML = '<div id="auth1-root" class="auth1-card">'
    + '<p class="auth1-h">Winter On The Ridge</p>'
    + '<p class="auth1-b">The last road out closed before dawn.</p>'
    + '<span class="auth1-rule"></span></div>';

const FIXTURE_TL = 'gsap.set(".auth1-card", { opacity: 0, y: 40 });\n'
    + 'tl.to(".auth1-card", { opacity: 1, y: 0, duration: 0.6 }, 0);\n'
    + 'tl.to(".auth1-card", { opacity: 0, duration: 0.4 }, 3.3);';

const CASES = [
    {
        id: 'side-tab',
        what: 'an accent bar down the side of a card',
        css: '.auth1-card { border-left: 3px solid var(--hf-accent); padding: 24px 28px; '
            + 'background: var(--hf-surface); color: var(--hf-text); }\n'
            + '.auth1-h { font-size: 64px; line-height: 1.05; }\n',
    },
    {
        id: 'pseudo-side-bar',
        what: 'a stripe drawn as an element instead of a border',
        css: '.auth1-card { padding: 24px 28px; background: var(--hf-surface); color: var(--hf-text); }\n'
            + '.auth1-rule { width: 5px; height: 72px; background: var(--hf-accent); display: block; }\n'
            + '.auth1-h { font-size: 64px; line-height: 1.05; }\n',
    },
    {
        id: 'tight-leading',
        what: 'display type with its lines touching',
        css: '.auth1-card { padding: 24px 28px; background: var(--hf-surface); color: var(--hf-text); }\n'
            + '.auth1-h { font-size: 72px; line-height: 0.7; }\n',
    },
    {
        id: 'overused-font',
        what: 'a typeface the checker bans outright',
        css: '.auth1-card { padding: 24px 28px; background: var(--hf-surface); color: var(--hf-text); }\n'
            + '.auth1-h { font-family: Lato, sans-serif; font-size: 72px; line-height: 1.05; }\n',
    },
];

for (const c of CASES) {
    const before = lint(c.css, c.id);
    check(
        `the ${c.id} fixture really is rejected today (${c.what})`,
        !before.ok,
        'the fixture no longer trips its own rule, so the repair below would be '
        + 'proved against nothing. Either the rule changed or the fixture is stale'
    );
    const fixed = repair.repairStyle(
        { html: FIXTURE_HTML, css: c.css, timeline: FIXTURE_TL },
        { theme: THEME, themeId: 'crime', kind: 'fullscreen' }
    );
    const after = lint(fixed.css, c.id);
    check(
        `the repair pass clears ${c.id} instead of burning a round on it`,
        after.ok && fixed.fixes.length > 0,
        `still rejected after repair: ${(after.errors[0] || '(no fix was applied)').slice(0, 120)}`
    );
}

// A four-edge border is a frame, not a tab. The rule does not flag it and the
// repair must not touch it — a repair that deletes design the checker was happy
// with is worse than no repair.
//
// Written per-edge, and sharing a stylesheet with a real breach, for two
// reasons that each defeat a simpler fixture. The `border:` shorthand sets no
// per-side widths, so a shorthand frame survives even a repair with its
// dominance test torn out. And a stylesheet with nothing wrong in it never
// reaches the repair at all, because a repair only runs while its rule is
// firing. Only this shape actually exercises the test.
const FRAME_BLOCK = '.auth1-frame { border-top: 3px solid var(--hf-accent); '
    + 'border-right: 3px solid var(--hf-accent); border-bottom: 3px solid var(--hf-accent); '
    + 'border-left: 3px solid var(--hf-accent); padding: 18px; }';
const FRAMED = '.auth1-card { border-left: 3px solid var(--hf-accent); padding: 24px; '
    + 'background: var(--hf-surface); color: var(--hf-text); }\n'
    + `${FRAME_BLOCK}\n`
    + '.auth1-h { font-size: 64px; line-height: 1.05; }\n';
const framedOut = repair.repairStyle(
    { html: FIXTURE_HTML, css: FRAMED, timeline: FIXTURE_TL },
    { theme: THEME, themeId: 'crime', kind: 'fullscreen' }
);
check(
    'the side-tab repair fires on the real breach in the same stylesheet',
    framedOut.fixes.length > 0,
    'the fixture did not trip side-tab at all, so the frame check below is '
    + 'measuring a repair that never ran'
);
check(
    'an even border on all four edges survives untouched',
    framedOut.css.includes(FRAME_BLOCK),
    'the repair pass stripped a uniform border. That is a deliberate frame, not '
    + 'the side-tab tell, and deleting it silently changes a design the checker '
    + 'had already accepted'
);

// The film-FX libraries paint coloured bars and glows on purpose. The checker
// exempts them; so must the repair, or every render loses its grade.
//
// The composition has to carry a REAL breach as well, because a repair only
// runs when its rule is currently firing. An fx-only fixture never reaches the
// repair at all, so it would pass just as happily with the exemption deleted.
const FX_CSS = '.auth1-rule { width: 5px; height: 72px; background: var(--hf-accent); display: block; }\n'
    + '.hf-fx-stripe { width: 4px; height: 200px; background: var(--hf-accent); }\n'
    + '.auth1-card { padding: 24px 28px; background: var(--hf-surface); color: var(--hf-text); }\n'
    + '.auth1-h { font-size: 64px; line-height: 1.05; }\n';
const fxOut = repair.repairStyle(
    { html: FIXTURE_HTML, css: FX_CSS, timeline: FIXTURE_TL },
    { theme: THEME, themeId: 'crime', kind: 'fullscreen' }
);
check(
    'the stripe repair fires on the real breach in the same stylesheet',
    fxOut.fixes.length > 0,
    'the fixture did not trip pseudo-side-bar at all, so the exemption check '
    + 'below is measuring a repair that never ran'
);
check(
    'the deliberate film-FX selectors are left alone',
    /\.hf-fx-stripe \{ width: 4px; height: 200px; background: var\(--hf-accent\); \}/.test(fxOut.css),
    'the repair pass edited an hf-fx- selector. Those bars and glows ARE the look; '
    + 'the checker exempts them and the repair must use the same exemption list'
);

// A composition with nothing wrong must come out byte-for-byte identical.
const CLEAN = '.auth1-card { padding: 24px 28px; background: var(--hf-surface); color: var(--hf-text); }\n'
    + '.auth1-h { font-size: 72px; line-height: 1.05; }\n';
const cleanOut = repair.repairStyle(
    { html: FIXTURE_HTML, css: CLEAN, timeline: FIXTURE_TL },
    { theme: THEME, themeId: 'crime', kind: 'fullscreen' }
);
check(
    'a clean composition is returned unchanged',
    cleanOut.css === CLEAN && cleanOut.fixes.length === 0,
    'the repair pass rewrote CSS that nothing objected to'
);

// The banned-font swap must not hand back another banned face.
const swapped = repair.repairStyle(
    { html: FIXTURE_HTML, css: CASES[3].css, timeline: FIXTURE_TL },
    { theme: THEME, themeId: 'crime', kind: 'fullscreen' }
).css;
const primary = (swapped.match(/font-family:\s*([^;]+)/i) || [])[1] || '';
check(
    'the font swap does not trade one banned face for another',
    !OVERUSED_FONTS.has(primary.split(',')[0].trim().replace(/^["']|["']$/g, '').toLowerCase()),
    `the repair substituted "${primary.trim()}", whose primary face is itself on `
    + 'the ban list. That is the exact loop the theme-font fix removed'
);

// ---------------------------------------------------------------------------
// 3. RECOVERY — the timeline is compressed onto its scene, not truncated.
// ---------------------------------------------------------------------------

const OVERRUN_TL = FIXTURE_TL;          // ends at 3.70s
const measured = author.inspectAuthoredTimeline(OVERRUN_TL);

check(
    'the overrun fixture really does overrun (3.70s of motion on a 3.50s scene)',
    Math.abs(measured.maxEnd - 3.7) < 0.001 && measured.errors.length === 0,
    `measured ${measured.maxEnd}s — the fixture no longer reproduces the real `
    + 'lower-third rejection, so the scaling proof below means nothing'
);

const scaled = repair.scaleTimelineToFit(OVERRUN_TL, 3.5, measured.maxEnd);
const scaledEnd = scaled ? author.inspectAuthoredTimeline(scaled.timeline).maxEnd : NaN;
check(
    'a small overrun is compressed until it fits',
    scaled && scaledEnd <= 3.5 + 0.03,
    `scaling produced ${scaled ? `${scaledEnd}s` : 'nothing'} for a 3.50s scene`
);

check(
    'compression is proportional — the choreography survives, it just lands on time',
    scaled && author.inspectAuthoredTimeline(scaled.timeline).calls.length === measured.calls.length
    && scaledEnd > 3.5 * 0.9,
    'scaling dropped or clipped tweens. Truncating turns a considered fade into '
    + 'a pop; the whole point is that every start and every duration moves by the '
    + 'same factor'
);

check(
    'an overrun too large to be arithmetic is left to the author',
    repair.scaleTimelineToFit(OVERRUN_TL, 2.4, 3.7) === null,
    'a 35% overrun was silently sped up. That is not a rounding slip — the '
    + 'composition was designed for a longer beat than it was given, and playing '
    + 'it a third faster hides a misunderstanding instead of fixing it'
);

check(
    'the scale floor is a real floor, not a formality',
    repair.MIN_TIMELINE_SCALE > 0.5 && repair.MIN_TIMELINE_SCALE < 1,
    `MIN_TIMELINE_SCALE is ${repair.MIN_TIMELINE_SCALE}`
);

// `repeat` is a count, not a time. Scaling it changes the animation rather than
// its tempo.
const REPEAT_TL = 'tl.to(".auth1-h", { opacity: 1, duration: 1, repeat: 3 }, 0);';
const repeatOut = repair.scaleTimelineToFit(REPEAT_TL, 3.5, 4);
check(
    'a repeat COUNT is never scaled as if it were a time',
    !repeatOut || /repeat:\s*3\b/.test(repeatOut.timeline),
    'the scaler rewrote `repeat: 3`. That is how many times the move plays, not '
    + 'how long it takes'
);

// ---------------------------------------------------------------------------
// 4. The rescue is actually wired in, and only ever helps.
// ---------------------------------------------------------------------------

// The anchors below are the whole statements, not just the call. An earlier
// version searched for "rescueComposition(parsed, brief)" alone, which a
// mutation that called the rescue and threw the result away still satisfied —
// a call whose output nobody reads is the same as no call.
const authorSrc = fs.readFileSync(AUTHOR_PATH, 'utf8');
const rescueCall = authorSrc.indexOf('const rescue = rescueComposition(parsed, brief);');
const rescueUsed = authorSrc.indexOf('parsed = rescue.parsed;');
const validateCall = authorSrc.indexOf('result = validateComposition(parsed,');
check(
    'the rescue runs BEFORE the validator, inside the author round loop',
    rescueCall > 0 && validateCall > rescueCall,
    'rescueComposition is not called ahead of validateComposition. Running it '
    + 'afterwards would repair a composition that had already been rejected and '
    + 'had already cost the round — which is the entire thing being fixed'
);
check(
    'the repaired composition is the one that gets validated',
    rescueUsed > rescueCall && validateCall > rescueUsed,
    'the rescue result is never assigned back to `parsed`, so the validator still '
    + 'sees the broken original and every repair is discarded silently'
);

const BRIEF = { ns: 'auth1', kind: 'fullscreen', themeId: 'crime', duration: 3.5, type: 'lower-third' };
const BROKEN = {
    html: FIXTURE_HTML,
    css: CASES[0].css,          // side-tab
    timeline: OVERRUN_TL,       // 3.70s on a 3.50s scene
};

const beforeVerdict = author.validateComposition(BROKEN, 'auth1', 3.5, [], BRIEF);
check(
    'the end-to-end fixture is genuinely rejected today',
    !beforeVerdict.ok && beforeVerdict.errors.some(e => e.includes('after the')),
    'the combined fixture passes validation unrepaired, so the rescue proof below '
    + 'would be measuring nothing'
);

const rescued = author.rescueComposition(BROKEN, BRIEF);
check(
    'the rescue fixes both defects in one pass',
    rescued && rescued.fixes.length === 2,
    `rescueComposition returned ${rescued ? `${rescued.fixes.length} fix(es)` : 'null'} `
    + 'for a composition carrying a bad border AND an overrun'
);

if (rescued) {
    const afterVerdict = author.validateComposition(rescued.parsed, 'auth1', 3.5, [], BRIEF);
    check(
        'the rescued composition passes the FULL validator, not just its own rules',
        afterVerdict.ok,
        `still rejected: ${(afterVerdict.errors[0] || '').slice(0, 140)}. A repair `
        + 'proved only against the rule it targeted is proved against half the contract'
    );
    check(
        'the rescued composition passes the slop checker too',
        slopLint(rescued.parsed, { theme: THEME, kind: 'fullscreen', source: 'composition' }).ok,
        'the repair cleared one rule and tripped another'
    );
}

// ---------------------------------------------------------------------------
// 5. The judgement calls must STAY rejections.
//
// This is the line the repair pass is not allowed to cross. Overlapping text,
// nothing animating in, a fact the narration never mentioned — those need a
// designer's decision, and auto-"fixing" them would ship a worse composition
// while reporting success. Worse than the fallback card, because nobody looks.
// ---------------------------------------------------------------------------

const JUDGEMENT_IDS = ['text-overlap', 'no-entrance', 'transform-ownership', 'number-not-in-brief'];
const repaired = new Set(repair.STYLE_REPAIRS.map(r => r.id));
check(
    'no judgement call has quietly become auto-repairable',
    JUDGEMENT_IDS.every(id => !repaired.has(id)),
    `${JUDGEMENT_IDS.filter(id => repaired.has(id)).join(', ')} is now being `
    + 'auto-fixed. Those have no single correct answer; papering over them ships '
    + 'a broken design with a green log line next to it'
);

check(
    'every auto-repair still targets a rule the checker actually enforces',
    repair.STYLE_REPAIRS.length > 0 && repair.STYLE_REPAIRS.every(r => RULE_BY_ID.has(r.id)),
    repair.STYLE_REPAIRS.filter(r => !RULE_BY_ID.has(r.id)).map(r => r.id).join(', ')
    + ' no longer names a rule the checker enforces — a repair whose rule was '
    + 'renamed is dead code that reports success by never firing'
);

// Warnings used to be unrepairable by construction: the loop asked the checker
// `ok`, and `ok` only counts errors, so a warn-severity rule could never even
// enter the loop. Two of the ugliest defects in the shipped build — letter
// spacing wide enough to read as gaps, and strokes too thin to survive the
// encoder — are warnings. They are repairable now, and this pins it, because
// the regression is completely silent: the repair stays in the list, keeps
// looking correct, and simply never runs.
const WARN_REPAIRS = repair.STYLE_REPAIRS
    .filter(r => RULE_BY_ID.has(r.id) && RULE_BY_ID.get(r.id).severity === 'warn')
    .map(r => r.id);
check(
    'a warning-level defect is repaired too, not silently skipped',
    WARN_REPAIRS.length > 0,
    'no repair targets a warn-severity rule any more — if that was deliberate, '
    + 'fine, but if the repair loop went back to gating on `ok` then every '
    + 'warning became unrepairable again and nothing here would have noticed'
);

const WIDE_TRACKING = `${FRAME_BLOCK}
.auth1-h { font-family: ${THEME.typography.heading}; font-size: 72px; line-height: 1.1; letter-spacing: 0.9em; }
.auth1-b { font-family: ${THEME.typography.body}; font-size: 30px; line-height: 1.4; }
`;
const wideBefore = slopLint({ html: FIXTURE_HTML, css: WIDE_TRACKING, timeline: FIXTURE_TL }, LINT_ALL);
check(
    'the wide-tracking fixture really is flagged today (letters far enough apart to read as gaps)',
    wideBefore.findings.some(f => f.id === 'wide-tracking'),
    'the fixture stopped tripping the rule, so what follows proves nothing'
);
const wideFixed = repair.repairStyle(
    { html: FIXTURE_HTML, css: WIDE_TRACKING, timeline: FIXTURE_TL },
    { theme: THEME, themeId: 'crime', kind: 'fullscreen' }
);
const wideAfter = slopLint({ html: FIXTURE_HTML, css: wideFixed.css, timeline: FIXTURE_TL }, LINT_ALL);
check(
    'the repair pass clears wide-tracking instead of leaving it in the render',
    !wideAfter.findings.some(f => f.id === 'wide-tracking') && wideFixed.fixes.length > 0,
    'a warning-level defect went out the door untouched'
);

// Easing is the one repair that has to reach into the timeline rather than the
// stylesheet, and the caller only picks that up because repairStyle returns it.
// If the return shape ever narrows back to { css, fixes }, the CSS half of a
// bounce fix would land and the GSAP half would vanish.
const BOUNCE_TL = `const tl = gsap.timeline();
tl.from('#auth1-root .auth1-h', { y: 40, opacity: 0, duration: 0.8, ease: 'back.out(1.7)' }, 0);
tl.from('#auth1-root .auth1-b', { y: 20, opacity: 0, duration: 0.7 }, 0.6);
`;
const bounceBefore = slopLint({ html: FIXTURE_HTML, css: CLEAN, timeline: BOUNCE_TL }, LINT_ALL);
check(
    'the bounce fixture really is rejected today (easing that overshoots and springs back)',
    bounceBefore.findings.some(f => f.id === 'bounce-easing'),
    'the fixture stopped tripping the rule, so what follows proves nothing'
);
const bounceFixed = repair.repairStyle(
    { html: FIXTURE_HTML, css: CLEAN, timeline: BOUNCE_TL },
    { theme: THEME, themeId: 'crime', kind: 'fullscreen' }
);
const bounceAfter = slopLint(
    { html: FIXTURE_HTML, css: bounceFixed.css, timeline: bounceFixed.timeline },
    LINT_ALL
);
check(
    'the repaired timeline comes back out of the repair pass',
    typeof bounceFixed.timeline === 'string'
    && !bounceAfter.findings.some(f => f.id === 'bounce-easing')
    && bounceFixed.timeline !== BOUNCE_TL,
    'the easing fix either did not happen or had nowhere to go — the caller '
    + 'reads styled.timeline, and a { css, fixes } return silently drops it'
);
check(
    'the easing repair leaves the choreography alone',
    /y: 40/.test(bounceFixed.timeline) && /duration: 0\.8/.test(bounceFixed.timeline)
    && /0\.6\)/.test(bounceFixed.timeline),
    'the repair rewrote more than the ease — timings and offsets are the '
    + "author's decisions, not this file's"
);

const numberFixture = { ...BROKEN, html: FIXTURE_HTML.replace('dawn.', 'dawn, 1,847 stranded.') };
check(
    'a number the narration never mentioned is still a rejection',
    !author.validateComposition(numberFixture, 'auth1', 3.5, [], BRIEF).ok,
    'the numeric whitelist stopped firing — invented facts would now render'
);

// ---------------------------------------------------------------------------
// 6. A failure is one bad sample, not a life sentence.
//
// Everything above makes a rejected composition recoverable WITHIN a build. It
// is all worthless if the first failure is then frozen into the cache, because
// the marker outlives every later improvement: the repair pass could grow to
// fifty fixes and the graphic that failed on 2026-08-05 would still serve its
// hardcoded card forever. The user rebuilds, sees the identical ugly card, and
// nothing they or we do can dislodge it — the exact "why am I fixing the same
// thing over and over" complaint this whole effort exists to end.
//
// The marker keeps ONE job: open mode (project open / refresh) must cost zero
// AI calls no matter what changed since the save, so there it still stands.
const failedBranch = authorSrc.indexOf('if (cache[hash].failed) {');
const staleLookup = authorSrc.indexOf('.filter(value => value && !value.failed && value.ns === brief.ns)');
const branchSrc = failedBranch > 0 && staleLookup > failedBranch
    ? authorSrc.slice(failedBranch, staleLookup)
    : '';

check(
    'a build re-authors a brief that failed on an earlier build',
    /\bpending\.push\(\{\s*brief,\s*hash,\s*i,\s*attempts:/.test(branchSrc),
    'the cached failure branch no longer queues the brief for authoring, so a '
    + 'graphic that failed once falls back to the generic card in every future '
    + 'build of that video — permanently, and invisibly'
);
check(
    'the retry is gated on it NOT being open mode',
    /if \(!openMode && !RETRY_FAILED_OFF\)/.test(branchSrc),
    'the retry is not fenced off from open mode. Opening a saved project would '
    + 'start spending AI, which is the one thing open mode guarantees it never does'
);
check(
    'open mode still honours the marker instead of authoring',
    /openMode/.test(branchSrc) && !/authorComposition\(/.test(branchSrc),
    'the open-mode arm of the failure branch calls the author directly'
);
check(
    'a cached failure no longer short-circuits both modes at once',
    !/cache\[hash\]\.failed \|\| cachedComp/.test(authorSrc),
    'the old combined condition is back — it treated "this sample failed" and '
    + '"this composition is reusable" as the same outcome, which is what made '
    + 'the failure permanent'
);
check(
    'the marker counts how many builds have failed on this brief',
    /attempts: retry \+ 1/.test(authorSrc),
    'failures are recorded without an attempt count, so a chronically '
    + 'unauthorable brief is indistinguishable in the log from a first miss'
);
check(
    'the retry can be switched off without editing code',
    /HF_AUTHOR_RETRY_FAILED/.test(authorSrc),
    'there is no kill switch, so a build cannot be made cheap and reproducible '
    + 'on demand'
);

console.log(`\n[verify] author rescue: ${checks - failures}/${checks} passed`);
if (failures > 0) {
    console.error(`[verify] FAILED (${failures})`);
    process.exit(1);
}
