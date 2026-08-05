/**
 * hf-video-lint.js — the sameness rules a web design detector cannot have.
 *
 * `hf-slop-lint.js` judges ONE composition: is this graphic a cliché? That is
 * everything a page-level detector like Impeccable can see, because a web page
 * is one artefact. A video is twenty artefacts played in sequence, and the AI
 * tell is not in any single one of them — every graphic can pass the slop
 * checker and the video still looks machine-made, because they all enter the
 * same way, sit in the same place, stay on screen for the same length of time
 * and arrive on a metronome.
 *
 * So this module judges the WHOLE video. It reads the render's own resolved
 * diagnostics (`buildVisualDiagnostics` in hyperframes-bridge.js) — the actual
 * decisions that shipped, not what the plan asked for — and reports repetition
 * across four axes plus two clock-based ones no static checker can reach:
 *
 *   motion    — do the graphics all enter the same way?
 *   layout    — do they all sit in the same arrangement?
 *   type      — is the video really just two kinds of card?
 *   pace      — are they all animated at the same speed?
 *   timing    — do they all stay on screen for the same length of time?
 *   spacing   — do they arrive at regular intervals like a metronome?
 *   reading   — is there time to actually READ each one? (this one is a defect,
 *               not a taste call, so it is the only 'error' in the file)
 *
 * Zero AI, zero network, zero browser — same contract as the slop linter.
 *
 * Two measures are used throughout, and neither is a flat percentage:
 *
 *   RUN — repeats in a row, judged against the even share. Two consecutive
 *   graphics that match read as a deliberate pair (a rhyme); three read as a
 *   pattern, and once the viewer sees the pattern they stop seeing the
 *   content. But three in a row means nothing on an axis with only three
 *   possible values, so a run must also be longer than an even deal would
 *   have handed that value anyway.
 *
 *   DOMINANCE — how many times its even share the most-used value takes,
 *   where "even share" is measured against the vocabulary THIS video actually
 *   demonstrated. See DOMINANCE_RATIO below for why a percentage was tried,
 *   measured against the real build, and thrown away.
 *
 * Severity contract matches hf-slop-lint.js:
 *   'error'    — a defect regardless of taste  → blocks / repairs
 *   'warn'     — real sameness, needs judgement → reported, never blocks
 *   'advisory' — informational only
 */
'use strict';

// ── Thresholds ─────────────────────────────────────────────────────────────

const RUN_LIMIT = 3;          // three consecutive identical choices = a pattern
const MIN_FOR_DOMINANCE = 6;  // below this, concentration proves nothing
const MIN_FOR_RHYTHM = 5;     // clock rules need a sequence to have a rhythm

/**
 * DOMINANCE is deliberately NOT a percentage.
 *
 * The first draft flagged "more than half the video uses one value", and
 * measuring the real Aug-1 build against it produced the wrong answer twice
 * over: the graphic types were concentrated (five of twenty were one card
 * type, out of fourteen types used) and it stayed silent, while the layouts
 * were genuinely varied and would have been caught by any threshold low
 * enough to see the types. A single percentage cannot serve an axis with two
 * options and an axis with fourteen.
 *
 * So the yardstick is the video's own vocabulary. If a video uses D distinct
 * values across N graphics, an even deal gives each one N/D. The dominance
 * ratio is how many times that even share the most-used value actually takes.
 * At 2.0 the top choice is being reached for twice as often as the video's own
 * range would suggest — that is a habit, not a choice, and it reads as one.
 *
 * This calibrates itself: a video that only ever demonstrated three layouts is
 * judged against three, and a video that demonstrated fourteen card types is
 * judged against fourteen. Nothing has to be re-tuned when the vocabulary grows.
 */
const DOMINANCE_RATIO = 2.0;

/**
 * Reading speed. 17 characters per second is the broadcast subtitle norm for
 * adult viewers (BBC subtitle guidelines and Netflix's timed-text spec both
 * sit at 17–20 cps; the lower end is the safe one). On-screen graphics are
 * read while the viewer is ALSO watching the footage, so 17 is a ceiling, not
 * a target.
 *
 * ENTRANCE_BLIND is the time the graphic spends animating in, during which it
 * is moving/fading and cannot be read. Every entrance in the system is in the
 * 0.4–0.8s band, so 0.6 is the honest middle.
 */
const READ_CPS = 17;
const ENTRANCE_BLIND = 0.6;
const MIN_DWELL = 1.2;        // below this nothing longer than a word registers
const READ_TOLERANCE = 0.15;  // don't fight over a sixth of a second

/**
 * The shortest window this text can occupy and still be readable.
 *
 * This is THE reading model for the whole system, and it is exported so nobody
 * has to restate it. Step 7.8 Motion QA — the stage that actually extends a
 * graphic's hold, hours before this linter ever runs — used to carry its own
 * rival estimate based on word count, whose per-character slope was roughly a
 * quarter of this one. The two disagreed on real builds: Motion QA declared a
 * graphic comfortable, shipped it, and then this linter called the very same
 * graphic unreadable at render time, when nothing was left that could fix it.
 * Two models of one fact is how that happens, so there is now one model and
 * Motion QA imports it.
 *
 * Accepts the text itself or a character count, and returns a duration in
 * seconds that already accounts for the entrance the viewer cannot read
 * through and the tolerance we refuse to argue over.
 */
function minimumReadableDuration(textOrLength) {
    const chars = typeof textOrLength === 'number'
        ? textOrLength
        : String(textOrLength || '').trim().length;
    if (!Number.isFinite(chars) || chars < 2) return 0;
    const read = chars / READ_CPS + ENTRANCE_BLIND - READ_TOLERANCE;
    // Anything past a single word needs a beat to register at all, however
    // short it is. Above 12 characters the reading term already clears this on
    // its own, so the floor only ever speaks for the very short strings.
    return chars > 12 ? Math.max(MIN_DWELL, read) : read;
}

/**
 * Uniformity floors for the two clock rules. A coefficient of variation is
 * spread divided by average, so it is scale-free: it means the same thing for
 * a video with 3-second graphics and one with 8-second graphics, which is
 * exactly why it is used here instead of a duration in seconds. Below ~0.12
 * the sequence is mechanically regular — that is a metronome, not a rhythm.
 */
const RHYTHM_CV_FLOOR = 0.12;

// ── Normalisation ──────────────────────────────────────────────────────────

/**
 * The system carries TWO spellings of the same motion vocabulary: camelCase
 * (`fadeSlide`, from themes/mg-registry/templates) and kebab (`fade-slide`,
 * from the motion QA agent and authored compositions). Whichever source wins
 * for a given graphic decides which spelling lands in the report — so the same
 * entrance gets counted twice under two names, and a variety report shows
 * variety that does not exist.
 *
 * Collapsing to lowercase alphanumerics makes the count honest. It is
 * deliberately not a lookup table: a table would need a new entry every time
 * someone adds a motion, and would silently under-count until they did.
 */
function motionFamily(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '') || 'unknown';
}

/**
 * ENTRANCE_LADDER — the entrance the VIEWER actually sees, per animation name.
 *
 * `motionFamily` above counts NAMES, which is the right instrument for a
 * report: two names is two names, and a report that merges them hides a
 * vocabulary problem. But a name is not a motion. The renderer picks the
 * on-screen entrance by testing the name for substrings, in this exact order
 * (`hfEnterState` in hyperframes-bridge.js), and the great majority of the
 * vocabulary matches NONE of them — `fadeSlide`, `staggerSlide`, `cascade`,
 * `fadeIn`, `typewriter`, `spinReveal`, `staggerBars` and `wordCascade` all
 * fall through to the same default rise.
 *
 * That matters the moment anything tries to FIX monotony rather than report
 * it. Swapping `fadeSlide` for `cascade` changes the label, silences the name
 * count, and changes nothing whatsoever on screen — a repair that games its own
 * linter. So variety is chosen against this ladder: a substitution only counts
 * if it lands in a different family here.
 *
 * Declarative rather than a chain of ifs so the verify gate can read it and
 * compare it against the renderer's source, and fail if the two ever drift.
 * Order is load-bearing: `right` must be tested before `left`, because
 * `slideOpposite` contains neither but `slideRight` must not be caught by the
 * `opposite` arm of the left test.
 */
const ENTRANCE_LADDER = [
    { family: 'wipe', any: ['wipe'] },
    { family: 'flip', any: ['flip'] },
    { family: 'scatter', any: ['scatter'] },
    { family: 'pop', any: ['spring', 'pop'] },
    { family: 'right', any: ['right'], not: ['opposite'] },
    { family: 'left', any: ['left', 'opposite'] },
    { family: 'up', any: ['up'] },
    { family: 'scale', any: ['scale'] },
];

/**
 * entranceFamily(animation, item) → one of the ENTRANCE_LADDER families, or
 * the two item-shaped defaults ('mapzoom', 'takeover'), or 'rise'.
 *
 * `item` is optional and only needs `{ type, kind }`. Without it the two
 * item-shaped branches cannot fire, which is correct: they are what the
 * renderer falls back to when the NAME says nothing, so a name-only question
 * gets the name-only answer.
 */
function entranceFamily(animation, item = null) {
    // Mirrors hfAnimName(): a missing name is 'fadeSlide' at the renderer, not
    // a blank — so a graphic that states nothing is classified as what it will
    // actually do, never as "unknown".
    const anim = String(animation || 'fadeSlide').replace(/[^a-z0-9]/gi, '').toLowerCase();
    for (const step of ENTRANCE_LADDER) {
        if (!step.any.some(t => anim.includes(t))) continue;
        if (step.not && step.not.some(t => anim.includes(t))) continue;
        return step.family;
    }
    if (String(item?.type || '') === 'map-chart') return 'mapzoom';
    const kind = String(item?.kind || '');
    if (kind === 'fullscreen' || kind === 'template') return 'takeover';
    return 'rise';
}

/**
 * MOTION_SPEED_STEPS — the system's own perceptible pace ladder.
 *
 * These are not thresholds and not an invention: they are exactly the numbers
 * the renderer's speed vocabulary resolves to (`very-slow`, `slow`, `normal`,
 * `fast`, `rapid` — `normalizeMotionSpeed` in hyperframes-bridge.js and its
 * runtime twin `hfSpeed`). They are declared once here because BOTH stages that
 * reason about pace need them, and because they answer the question a
 * continuous number cannot: what is the smallest speed change a viewer can
 * actually see? Anything finer is a different number, not a different pace, so
 * spreading speeds across a continuum would satisfy a variety count without
 * changing the video — the exact failure mode this whole pass exists to avoid.
 *
 * The verify gate reads the renderer's source and fails if these drift apart.
 */
const MOTION_SPEED_STEPS = [0.55, 0.75, 1, 1.35, 1.6];

/** Snap a computed speed onto the nearest rung the viewer can actually see. */
function snapMotionSpeed(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 1;
    let best = MOTION_SPEED_STEPS[0];
    let bestGap = Infinity;
    for (const step of MOTION_SPEED_STEPS) {
        const gap = Math.abs(step - n);
        // Strict `<` keeps the lower rung on an exact tie, so the choice is
        // deterministic rather than dependent on array order changing.
        if (gap < bestGap) { bestGap = gap; best = step; }
    }
    return best;
}

function label(value) {
    const s = String(value == null ? '' : value).trim();
    return s || '(none)';
}

// ── Measurement helpers ────────────────────────────────────────────────────

/**
 * distribution(values) → { n, counts, top, topCount, share, distinct }
 * `values` are already normalised by the caller.
 */
function distribution(values) {
    const counts = new Map();
    for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
    let top = null;
    let topCount = 0;
    for (const [v, c] of counts) {
        if (c > topCount) { top = v; topCount = c; }
    }
    return {
        n: values.length,
        counts,
        top,
        topCount,
        share: values.length ? topCount / values.length : 0,
        distinct: counts.size,
    };
}

/**
 * longestRun(values) → { value, length, startIndex }
 * The consecutive-repeat measure. Order matters here and only here, which is
 * why the items are kept in timeline order all the way through.
 */
function longestRun(values) {
    let best = { value: null, length: 0, startIndex: 0 };
    let i = 0;
    while (i < values.length) {
        let j = i + 1;
        while (j < values.length && values[j] === values[i]) j++;
        if (j - i > best.length) best = { value: values[i], length: j - i, startIndex: i };
        i = j;
    }
    return best;
}

/** Coefficient of variation — spread relative to average, so it is unitless. */
function coefficientOfVariation(numbers) {
    const xs = numbers.filter(n => Number.isFinite(n) && n > 0);
    if (xs.length < 2) return NaN;
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    if (mean <= 0) return NaN;
    const variance = xs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / xs.length;
    return Math.sqrt(variance) / mean;
}

function pct(x) { return `${Math.round(x * 100)}%`; }

/**
 * A generic sameness rule over one axis. Both findings it can produce are
 * about the same axis but they are genuinely different failures — a run is
 * local ("these three in a row"), a majority is global ("the whole video") —
 * so they are reported separately and worded differently.
 */
function samenessScan(ctx, { field, noun, fix, minTotal = 0 }) {
    const items = ctx.items;
    if (items.length < Math.max(2, minTotal)) return [];
    const out = [];

    // ── "not recorded" is not a choice ────────────────────────────────────
    //
    // An authored composition carries its motion inside a GSAP timeline, so it
    // has no `animation` or `speed` string at all. Those arrive here as
    // "unknown" and "", and counting them was worth four findings on a probe of
    // eight authored graphics: "all 8 graphics use the entrance 'unknown' — the
    // video never varies it once". That reads like a damning verdict and means
    // only that nobody wrote the field down.
    //
    // Absence and repetition are opposite failures and must never share a
    // counter. A blank is dropped from the tally, and a run is BROKEN by one
    // rather than continued through it — a gap in the record is not evidence
    // that the graphics either side of it matched.
    const isRecorded = (v) => v != null && v !== '' && v !== 'unknown';
    const rawValues = items.map((it) => it[field]);
    const knownValues = rawValues.filter(isRecorded);
    if (knownValues.length < 2) return [];

    // A per-position sentinel: never equal to a real value, and never equal to
    // another blank, so a stretch of unrecorded graphics cannot form a run.
    const runValues = rawValues.map((v, i) => (isRecorded(v) ? v : `\u0000unrecorded:${i}`));

    const run = longestRun(runValues);
    const dist = distribution(knownValues);
    const evenShare = dist.distinct ? dist.n / dist.distinct : dist.n;
    // Every message below counts against the graphics that actually recorded
    // this axis, so name that population when it is not the whole video —
    // otherwise "all 6 graphics" in a 9-graphic video reads as a miscount.
    // When the population is partial its own phrase already names the axis, so
    // the sentence must not name it a second time ("the 6 graphics that record
    // the entrance use the entrance ...").
    const partial = dist.n !== items.length;
    const everyone = partial
        ? `the ${dist.n} graphics that record ${noun} (of ${items.length}) all use`
        : `all ${dist.n} graphics use ${noun}`;
    const someOfThem = partial
        ? `${dist.topCount} of the ${dist.n} graphics that record ${noun} (of ${items.length}) use`
        : `${dist.topCount} of ${dist.n} graphics use ${noun}`;

    // Only one value in the whole video. No ratio can express this — every
    // ratio against a vocabulary of one is 1.0 — and no threshold is needed
    // to know it is sameness.
    const singleValue = dist.n >= MIN_FOR_DOMINANCE && dist.distinct === 1;
    const dominance = evenShare > 0 ? dist.topCount / evenShare : 0;
    const dominant = dist.n >= MIN_FOR_DOMINANCE && !singleValue && dominance >= DOMINANCE_RATIO;

    // A run only counts when it is longer than an even deal would have given
    // that value anyway. Speed has three possible values, so three of them in
    // a row means nothing; layout has six or more, so four in a row is a
    // decision someone stopped making. Comparing against the even share is
    // what tells those two cases apart without a per-axis exception.
    const runIsNotable = run.length >= RUN_LIMIT
        && run.length > evenShare
        && !(singleValue && run.length === items.length);
    if (runIsNotable) {
        const from = items[run.startIndex];
        const to = items[run.startIndex + run.length - 1];
        out.push({
            snippet: `${run.length} graphics in a row use ${noun} "${label(run.value)}" (${from.at}s → ${to.at}s)`,
            hint: fix,
        });
    }

    if (singleValue) {
        out.push({
            snippet: `${everyone} "${label(dist.top)}" — `
                + `${partial ? 'every one that states it states the same one' : 'the video never varies it once'}`,
            hint: fix,
        });
    } else if (dominant) {
        out.push({
            snippet: `${someOfThem} "${label(dist.top)}" — `
                + `${dominance.toFixed(1)}× its even share of the ${dist.distinct} the video actually uses`,
            hint: fix,
        });
    }
    return out;
}

// ── Rules ──────────────────────────────────────────────────────────────────

const VIDEO_RULES = [
    {
        id: 'motion-vocabulary-split',
        severity: 'warn',
        why: 'the same entrance is recorded under two spellings, so the variety report hides monotony behind its own naming',
        scan(ctx) {
            const byFamily = new Map();
            for (const it of ctx.items) {
                if (!byFamily.has(it.motionFamily)) byFamily.set(it.motionFamily, new Map());
                const spellings = byFamily.get(it.motionFamily);
                spellings.set(it.animationRaw, (spellings.get(it.animationRaw) || 0) + 1);
            }
            const out = [];
            for (const [family, spellings] of byFamily) {
                if (spellings.size < 2) continue;
                const parts = [...spellings.entries()].map(([s, c]) => `${label(s)}×${c}`).join(' + ');
                const total = [...spellings.values()].reduce((a, b) => a + b, 0);
                out.push({
                    snippet: `"${family}" appears as ${parts} — ${total} of ${ctx.items.length} graphics share one entrance under ${spellings.size} names`,
                    hint: 'Normalise the entrance vocabulary at the source so the variety report counts one motion once.',
                });
            }
            return out;
        },
    },
    {
        id: 'motion-monotony',
        severity: 'warn',
        why: 'when every graphic enters the same way the viewer stops seeing the graphics and starts seeing the template',
        scan(ctx) {
            return samenessScan(ctx, {
                field: 'motionFamily',
                noun: 'the entrance',
                fix: 'Vary the entrance with the beat: a reveal for a fact, a settle for a quote, a cut-in for a hard statistic.',
            });
        },
    },
    {
        id: 'pace-monotony',
        severity: 'warn',
        why: 'one animation speed for a whole video flattens emphasis — nothing can feel urgent if everything moves at the same rate',
        scan(ctx) {
            return samenessScan(ctx, {
                field: 'speed',
                noun: 'the speed',
                fix: 'Let the speed follow the narration: fast on a punchline, slow on a reveal.',
                minTotal: MIN_FOR_DOMINANCE,
            });
        },
    },
    {
        id: 'layout-monotony',
        severity: 'warn',
        why: 'graphics that always occupy the same part of the frame make the video feel like a slide deck',
        scan(ctx) {
            return samenessScan(ctx, {
                field: 'layout',
                noun: 'the layout',
                fix: 'Move the weight around the frame — a full-bleed title after two side panels resets the eye.',
            });
        },
    },
    {
        id: 'type-monotony',
        severity: 'warn',
        why: 'a video built from two card types is a template with the text swapped, which is exactly what an AI-made video looks like',
        scan(ctx) {
            return samenessScan(ctx, {
                field: 'type',
                noun: 'the graphic type',
                fix: 'Match the graphic to what the line is doing — a number wants a stat, a contrast wants a comparison, a place wants a map.',
            });
        },
    },
    {
        id: 'opening-metronome',
        severity: 'warn',
        why: 'an authored graphic states its pace in its timeline, not in a label — if every one of them takes the same time to arrive, the video has one speed no matter how many entrance names the plan lists',
        scan(ctx) {
            // The companion to pace-monotony, for the graphics pace-monotony
            // cannot see. An authored composition's `speed` string is resolved
            // from the plan and describes a renderer that never runs, so the
            // only honest evidence is the timeline it shipped. Measured in
            // seconds and judged by spread, so it needs no vocabulary and no
            // bucket boundaries — the same instrument as metronome-timing,
            // pointed at the opening move instead of the hold.
            const spans = ctx.items
                .map(it => it.openSpan)
                .filter(s => Number.isFinite(s) && s > 0);
            if (spans.length < MIN_FOR_RHYTHM) return [];
            const cv = coefficientOfVariation(spans);
            if (!Number.isFinite(cv) || cv >= RHYTHM_CV_FLOOR) return [];
            const mean = spans.reduce((a, b) => a + b, 0) / spans.length;
            const scope = spans.length === ctx.items.length
                ? `${spans.length} graphics`
                : `${spans.length} of the ${ctx.items.length} graphics`;
            return [{
                snippet: `${scope} take about the same ${mean.toFixed(2)}s to arrive (spread ${pct(cv)} of the average)`,
                hint: 'Pace is editorial: a hard number can snap in, a quote can settle. Vary how long the opening move takes, not just what moves.',
            }];
        },
    },
    {
        id: 'metronome-timing',
        severity: 'warn',
        why: 'graphics that all stay on screen for the same length of time expose the generator — a human editor holds a hard fact longer than a caption',
        scan(ctx) {
            const durations = ctx.items.map(it => it.duration).filter(d => Number.isFinite(d) && d > 0);
            if (durations.length < MIN_FOR_RHYTHM) return [];
            const cv = coefficientOfVariation(durations);
            if (!Number.isFinite(cv) || cv >= RHYTHM_CV_FLOOR) return [];
            const mean = durations.reduce((a, b) => a + b, 0) / durations.length;
            return [{
                snippet: `${durations.length} graphics all hold for about ${mean.toFixed(1)}s (spread ${pct(cv)} of the average)`,
                hint: 'Let duration follow content weight: a headline can flash, a statistic needs to be read twice.',
            }];
        },
    },
    {
        id: 'metronome-spacing',
        severity: 'warn',
        why: 'graphics arriving at regular intervals feel scheduled rather than motivated by the script',
        scan(ctx) {
            const starts = ctx.items.map(it => it.at).filter(t => Number.isFinite(t)).sort((a, b) => a - b);
            if (starts.length < MIN_FOR_RHYTHM) return [];
            const gaps = [];
            for (let i = 1; i < starts.length; i++) gaps.push(starts[i] - starts[i - 1]);
            const cv = coefficientOfVariation(gaps);
            if (!Number.isFinite(cv) || cv >= RHYTHM_CV_FLOOR) return [];
            const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
            return [{
                snippet: `graphics arrive every ${mean.toFixed(1)}s like clockwork (spread ${pct(cv)} of the average)`,
                hint: 'Place graphics where the script earns them, then leave real gaps of plain footage between them.',
            }];
        },
    },
    {
        id: 'unreadable-in-time',
        severity: 'error',
        why: `text cannot be read faster than about ${READ_CPS} characters a second, and the entrance animation eats the first moments`,
        scan(ctx) {
            const out = [];
            for (const it of ctx.items) {
                if (!Number.isFinite(it.duration) || it.duration <= 0) continue;
                const chars = it.textLength;
                if (chars < 2) continue;
                if (chars > 12 && it.duration < MIN_DWELL) {
                    out.push({
                        snippet: `"${it.text.slice(0, 48)}" holds for only ${it.duration.toFixed(1)}s`,
                        hint: `Anything longer than a word needs at least ${MIN_DWELL}s on screen.`,
                    });
                    continue;
                }
                const needed = chars / READ_CPS + ENTRANCE_BLIND;
                // Same threshold as before, expressed through the shared model
                // so this rule and Motion QA can never drift apart again. (The
                // MIN_DWELL floor inside it cannot bite here: the branch above
                // already took every item that fell under it.)
                //
                // The microsecond is float slack, not tolerance — the real one
                // is READ_TOLERANCE and it is already inside the model. Motion
                // QA extends a graphic to land exactly ON this boundary, and
                // that duration comes back as a subtraction of two timeline
                // stamps, so it can miss by a last-bit rounding error. Without
                // the epsilon a graphic that was repaired perfectly could still
                // be reported unreadable, which would send someone hunting a
                // bug that is only arithmetic.
                if (minimumReadableDuration(chars) > it.duration + 1e-6) {
                    out.push({
                        snippet: `${chars} characters need about ${needed.toFixed(1)}s to read but the graphic holds for ${it.duration.toFixed(1)}s ("${it.text.slice(0, 40)}")`,
                        hint: 'Cut the text down or extend the hold — a graphic nobody can finish reading is worse than no graphic.',
                    });
                }
            }
            return out.slice(0, 8);
        },
    },
];

const VIDEO_RULE_IDS = VIDEO_RULES.map(r => r.id);
const VIDEO_RULE_BY_ID = new Map(VIDEO_RULES.map(r => [r.id, r]));

// ── Entry point ────────────────────────────────────────────────────────────

/**
 * Normalise whatever the caller has into one timeline-ordered item list.
 * Accepts the bridge's visual report (`{ resolved: [...] }`), a bare array of
 * resolved entries, or a plan-ish `{ motionGraphics: [...] }` — so this can be
 * pointed at a saved diagnostics file or at a live render without adapters.
 */
function normalizeItems(input) {
    const raw = Array.isArray(input)
        ? input
        : (input?.resolved || input?.graphics || input?.motionGraphics || []);
    const items = raw.map((g) => {
        const at = Number(g?.startTime ?? g?.start ?? g?.at ?? NaN);
        const duration = Number(g?.duration ?? g?.displayDuration ?? g?.durationSeconds ?? NaN);
        const text = String(g?.text ?? g?.title ?? '');
        // Present only when the bridge confirmed the agent's composition is the
        // one that ships, and only with a real opening span — a stamp without
        // usable numbers is treated as no stamp at all.
        const span = Number(g?.authoredMotion?.openSpan);
        const measured = (g?.authoredMotion && Number.isFinite(span) && span > 0)
            ? g.authoredMotion
            : null;
        return {
            type: String(g?.type ?? ''),
            kind: String(g?.kind ?? 'graphic'),
            layout: String(g?.layout ?? g?.compositionLayout ?? ''),
            // A stale label lies louder than a missing one.
            //
            // When the bridge stamps measured motion, it is telling us this
            // graphic shipped the agent's own GSAP timeline — and the runtime
            // then replaces the default entrance with a plain opacity gate so
            // the two cannot fight. `animation` and `speed` are still in the
            // report, but they were resolved from the PLAN and now label a
            // renderer that never runs. Worse, every authored composition
            // carries the identical pair, so counting them reported "all 6
            // graphics use the speed 1" about a video whose graphics opened at
            // 0.22s, 1.10s, 0.45s, 0.85s, 0.30s and 1.35s — a monotony verdict
            // on the most varied thing in the sequence.
            //
            // So the labels are dropped exactly like an unrecorded field, and
            // the pace of these graphics is judged instead by opening-metronome
            // on the seconds they actually took. Same rule, different evidence.
            animationRaw: measured ? '' : String(g?.animation ?? ''),
            motionFamily: measured ? '' : motionFamily(g?.animation),
            speed: measured ? '' : String(g?.speed ?? ''),
            openSpan: measured ? Number(measured.openSpan) : NaN,
            beats: measured ? Number(measured.beats) : NaN,
            themeId: String(g?.themeId ?? ''),
            at: Number.isFinite(at) ? Math.round(at * 100) / 100 : NaN,
            duration: Number.isFinite(duration) ? Math.round(duration * 100) / 100 : NaN,
            text,
            // The report truncates `text` for readability; `textLength` carries
            // the real length so the reading-speed rule is not measuring the
            // truncation instead of the copy.
            textLength: Number.isFinite(Number(g?.textLength)) ? Number(g.textLength) : text.length,
        };
    });
    // Timeline order — the run rules are meaningless in any other order, and
    // the caller's array is not guaranteed to be sorted.
    items.sort((a, b) => {
        const at = Number.isFinite(a.at) ? a.at : Infinity;
        const bt = Number.isFinite(b.at) ? b.at : Infinity;
        return at - bt;
    });
    return items;
}

/**
 * videoLint(report, opts) → { ok, errors, findings, counts, stats }
 *
 * `errors` are pre-phrased so they append straight onto a repair round, the
 * same contract as slopLint. `stats` carries the honest distributions so the
 * caller can log or persist them without recomputing.
 *
 * opts: { only: [ids], disable: [ids] }
 */
function videoLint(report, opts = {}) {
    const items = normalizeItems(report);
    const ctx = { items, report };
    const only = opts.only && opts.only.length ? new Set(opts.only) : null;
    const disable = new Set(opts.disable || []);
    const findings = [];
    for (const rule of VIDEO_RULES) {
        if (only && !only.has(rule.id)) continue;
        if (disable.has(rule.id)) continue;
        let hits;
        try { hits = rule.scan(ctx) || []; } catch (_) { continue; }
        for (const h of hits) {
            findings.push({
                id: rule.id,
                severity: rule.severity,
                why: rule.why,
                snippet: h.snippet || '',
                hint: h.hint || '',
            });
        }
    }
    // Collapse identical findings. The per-graphic rules walk every item, so a
    // video whose graphics genuinely share a fault reports that fault once per
    // graphic — the first live run against a real render printed the same
    // "104 characters need 6.7s" line eight times. The repeat count is the
    // useful part, the repetition is not, so the occurrences are merged and the
    // tally is carried on the finding.
    const merged = new Map();
    for (const f of findings) {
        const key = `${f.id}\u0000${f.snippet}`;
        const prior = merged.get(key);
        if (prior) { prior.occurrences += 1; continue; }
        merged.set(key, { ...f, occurrences: 1 });
    }
    findings.length = 0;
    for (const f of merged.values()) {
        if (f.occurrences > 1) f.snippet = `${f.snippet} — and ${f.occurrences - 1} more like it`;
        findings.push(f);
    }

    const counts = {};
    for (const f of findings) counts[f.id] = (counts[f.id] || 0) + 1;
    const errors = findings
        .filter(f => f.severity === 'error')
        .map(f => `${f.id}: ${f.snippet} — ${f.why}${f.hint ? `. ${f.hint}` : ''}`);

    const tally = (field) => {
        const d = distribution(items.map(i => label(i[field])));
        return Object.fromEntries([...d.counts.entries()].sort((a, b) => b[1] - a[1]));
    };
    const durations = items.map(i => i.duration).filter(d => Number.isFinite(d) && d > 0);
    const starts = items.map(i => i.at).filter(t => Number.isFinite(t)).sort((a, b) => a - b);
    const gaps = starts.slice(1).map((t, i) => t - starts[i]);

    return {
        ok: errors.length === 0,
        errors,
        findings,
        counts,
        stats: {
            total: items.length,
            byMotionFamily: tally('motionFamily'),
            byAnimationRaw: tally('animationRaw'),
            byLayout: tally('layout'),
            byType: tally('type'),
            bySpeed: tally('speed'),
            durationCv: Number.isFinite(coefficientOfVariation(durations)) ? Number(coefficientOfVariation(durations).toFixed(3)) : null,
            spacingCv: Number.isFinite(coefficientOfVariation(gaps)) ? Number(coefficientOfVariation(gaps).toFixed(3)) : null,
        },
    };
}

module.exports = {
    videoLint,
    motionFamily,
    entranceFamily,
    ENTRANCE_LADDER,
    MOTION_SPEED_STEPS,
    snapMotionSpeed,
    minimumReadableDuration,
    normalizeItems,
    distribution,
    longestRun,
    coefficientOfVariation,
    VIDEO_RULES,
    VIDEO_RULE_IDS,
    VIDEO_RULE_BY_ID,
    RUN_LIMIT,
    DOMINANCE_RATIO,
    MIN_FOR_DOMINANCE,
    READ_CPS,
    ENTRANCE_BLIND,
    MIN_DWELL,
    READ_TOLERANCE,
    RHYTHM_CV_FLOOR,
};
