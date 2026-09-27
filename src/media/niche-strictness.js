'use strict';

/**
 * NICHE FOOTAGE STRICTNESS — how much accuracy this niche's footage owes the viewer.
 *
 * `clip-analyzer._getNicheSegmentRules()` has always known this: it labels news
 * and crime "strict", history "moderate", sport / nature / food / diy / motivation
 * "relaxed". But that label only ever reached the vision PROMPT. The accept
 * decision underneath it was one hardcoded number — 6 — for every niche on the
 * planet, so the label changed what the judge was told to look for and nothing
 * about what we did with its answer.
 *
 * Aug-16 build, measured: 60 stock clips vs 38 real. 40 clips scored exactly
 * 5/10 and 23 scored 4/10. On a sport/person video most of those 4s and 5s were
 * REAL footage of the actual people and events, rejected by the ≥6 floor — after
 * which the scene fell through to a polished, generic, on-nothing stock clip that
 * scored 6. We rejected the footage the video was about and kept the footage it
 * was not.
 *
 * ── The two axes ─────────────────────────────────────────────────────────────
 * STRICTNESS decides the accept floor. On a news or crime video the wrong clip is
 * a factual error, so the bar stays where it is. On a sport, celebrity or DIY
 * video "rough but really them" is the honest cut, and a 4-5 real clip is worth
 * more than a 6 that shows nobody.
 *
 * REAL-FIRST decides provider order, and it is deliberately NARROWER than
 * "relaxed". Nature and food are relaxed AND genuinely better served by stock —
 * a 4K stock waterfall IS the shot. Sport, celebrity, entertainment and drama are
 * relaxed AND cannot be served by stock at all, because free stock libraries hold
 * no footage of the person the video is about. Only the second group reorders.
 *
 * ── Why it fails closed ──────────────────────────────────────────────────────
 * An unrecognised or empty niche resolves to `strict`, which returns the caller's
 * own unchanged floor. Nothing moves unless a niche is explicitly listed here, so
 * adding a niche to `niches.js` can never silently loosen its footage bar.
 *
 * ── What this deliberately does NOT do ───────────────────────────────────────
 * It never lowers a floor below `HARD_JUNK_FLOOR`. Wrong-sport, unrelated-setting
 * and presenter-at-desk clips land at 3 or lower in every niche, and they stay
 * rejected in every niche. "Accuracy is optional" means a different day is fine,
 * not that a different subject is fine.
 */

const { personSubjectMinScore } = require('./person-subject');

/** No niche accepts junk. 3 and below is "wrong subject", not "rough footage". */
const HARD_JUNK_FLOOR = 4;

/**
 * Leaf token → strictness. Resolved leaf-first (see `nicheFootageStrictness`),
 * so `news.celebrity` is relaxed while `news.politics` is strict: the family says
 * where the script came from, the leaf says what is actually on screen.
 */
const STRICTNESS_BY_TOKEN = {
    // Accuracy IS the product. A clip of the wrong war is a factual error.
    news: 'strict',
    breaking: 'strict',
    politics: 'strict',
    crime: 'strict',
    military: 'strict',
    war: 'strict',
    general: 'strict',

    // Real events, but a period-plausible or category-plausible shot is honest
    // B-roll — nobody has the original footage.
    history: 'moderate',
    economy: 'moderate',
    tech: 'moderate',

    // The viewer wants to SEE the people and the thing. Polish is not accuracy.
    sport: 'relaxed',
    sports: 'relaxed',
    celebrity: 'relaxed',
    entertainment: 'relaxed',
    drama: 'relaxed',
    motivation: 'relaxed',
    nature: 'relaxed',
    food: 'relaxed',
    health: 'relaxed',
    diy: 'relaxed',
    business: 'relaxed',
    luxury: 'relaxed',
    explainer: 'relaxed',
    education: 'relaxed',
};

/** How far below the caller's strict floor each strictness may reach. */
const FLOOR_DELTA = { strict: 0, moderate: 1, relaxed: 2 };

/**
 * Niches that must open real sources BEFORE stock, regardless of the per-scene
 * `sourceHint` the Visual Planner guessed.
 *
 * Narrower than "relaxed" on purpose. `SOURCE_PRIORITY_MAP['stock']` puts Pexels
 * first, and that hint is what produced the stock-heavy person build — but the
 * same reorder applied to a nature video would open YouTube for a waterfall
 * stock already holds in 4K, which is slower AND worse. This list is the set
 * where stock structurally cannot hold the footage: it is about specific real
 * people and specific real events.
 */
const REAL_FIRST_TOKENS = new Set(['sport', 'sports', 'celebrity', 'entertainment', 'drama']);

const STOCK_SOURCE_TOKENS = ['pexels', 'pixabay', 'storyblocks'];
const REAL_SOURCE_TOKENS = ['youtube', 'reddit', 'bing', 'brave'];

function _str(v) {
    return typeof v === 'string' ? v : (v == null ? '' : String(v));
}

function _tokens(niche) {
    return _str(niche).toLowerCase().split(/[^a-z]+/).filter(Boolean);
}

/**
 * How much accuracy this niche's footage owes the viewer.
 *
 * Leaf-first: the LAST recognised token wins, so `explainer.crime` is strict and
 * `news.celebrity` is relaxed. Unknown or empty → `strict`, which is the
 * pre-existing behaviour for every caller.
 *
 * @param {string} niche - a niche id (`explainer.sport`, `news.politics`, …) or a bare name
 * @returns {'strict'|'moderate'|'relaxed'}
 */
function nicheFootageStrictness(niche) {
    const tokens = _tokens(niche);
    for (let i = tokens.length - 1; i >= 0; i--) {
        const hit = STRICTNESS_BY_TOKEN[tokens[i]];
        if (hit) return hit;
    }
    return 'strict';
}

/**
 * Is this provider a stock library, real footage, or something we cannot tell?
 * Accepts either a provider key (`pexels`) or a display name (`Pexels Video`).
 *
 * @returns {'stock'|'real'|'unknown'}
 */
function footageSourceClass(provider) {
    const name = _str(provider).toLowerCase();
    if (!name) return 'unknown';
    if (STOCK_SOURCE_TOKENS.some(t => name.includes(t))) return 'stock';
    if (REAL_SOURCE_TOKENS.some(t => name.includes(t))) return 'real';
    return 'unknown';
}

/** Does this niche want real footage even when it is rougher than the stock alternative? */
function prefersRealOverStock(niche) {
    return nicheFootageStrictness(niche) === 'relaxed';
}

/** Should this niche open real sources before stock ones? See REAL_FIRST_TOKENS. */
function nicheWantsRealFootageFirst(niche) {
    if (!prefersRealOverStock(niche)) return false;
    return _tokens(niche).some(t => REAL_FIRST_TOKENS.has(t));
}

/**
 * How many points of vision score a stock clip must beat a real one by before it
 * takes the scene on a relaxed niche. A stock 6 does NOT outrank a real 5.
 */
function realOverStockTolerance() {
    const parsed = parseInt(_str(process.env.FOOTAGE_REAL_OVER_STOCK_TOLERANCE) || '2', 10);
    return Math.max(0, Math.min(4, Number.isFinite(parsed) ? parsed : 2));
}

/**
 * The score bonus a real-source candidate carries when it competes head-to-head
 * with stock. The half point is what makes the tolerance inclusive: at a bonus of
 * exactly `tolerance`, a stock lead of exactly `tolerance` would TIE and be
 * settled by unrelated tiebreakers. "Do not let stock outrank real by ≤ 2" has to
 * mean real still wins at exactly 2.
 *
 * @returns {number} points on the 0-10 vision scale (0 when the bias does not apply)
 */
function realSourceScoreBonus(niche, sourceClass) {
    if (sourceClass !== 'real') return 0;
    if (!prefersRealOverStock(niche)) return 0;
    return realOverStockTolerance() + 0.5;
}

/**
 * THE accept floor for a downloaded/validated clip. One function, both call
 * sites (`clip-analyzer._parseWindowValidation` and the footage-manager candidate
 * race), so the pre-download bar and the post-download bar can never drift.
 *
 * Three inputs move it, and only ever downward:
 *  - niche strictness   — relaxed -2, moderate -1, strict unchanged
 *  - source class       — STOCK KEEPS THE STRICT FLOOR. This is the real-over-
 *                         stock preference expressed as an asymmetric bar: it
 *                         admits rough real footage without admitting rough
 *                         generic footage, so it can only ever ADD an accept
 *                         that used to fail, never remove one that used to pass.
 *  - person subject     — already lowers to 4 on a main-character scene; the two
 *                         relaxations stack by taking the lower, so person-subject
 *                         on a relaxed niche is still 4 and not 2.
 *
 * @param {Object} opts
 * @param {string} [opts.niche]              niche id
 * @param {number} [opts.strictFloor=6]      the caller's own unchanged floor
 * @param {string} [opts.sourceProvider]     provider key or display name
 * @param {boolean} [opts.personSubjectActive]
 * @returns {number} integer floor, never below HARD_JUNK_FLOOR, never above strictFloor
 */
function footageAcceptFloor(opts = {}) {
    const parsedStrict = Number(opts.strictFloor);
    const strictFloor = Number.isFinite(parsedStrict) ? parsedStrict : 6;

    let floor = strictFloor;
    if (footageSourceClass(opts.sourceProvider) !== 'stock') {
        const delta = FLOOR_DELTA[nicheFootageStrictness(opts.niche)] || 0;
        floor = Math.max(HARD_JUNK_FLOOR, strictFloor - delta);
    }
    if (opts.personSubjectActive) {
        floor = Math.min(floor, personSubjectMinScore(strictFloor));
    }
    return Math.min(strictFloor, floor);
}

module.exports = {
    nicheFootageStrictness,
    footageSourceClass,
    footageAcceptFloor,
    prefersRealOverStock,
    nicheWantsRealFootageFirst,
    realOverStockTolerance,
    realSourceScoreBonus,
    HARD_JUNK_FLOOR,
    STRICTNESS_BY_TOKEN,
};
