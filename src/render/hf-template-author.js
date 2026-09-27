/**
 * hf-template-author.js — Agent-authored HyperFrames compositions.
 *
 * The editor agent's "use the skill and build a template for this scene" loop,
 * internalized: for each template / fullscreen-MG scene the AI authors a
 * bespoke { html, css, timeline } composition guided by the skill pack
 * (skills/hyperframes-template/SKILL.md + house-style.md) and the project's
 * DESIGN doc (hf-design-doc.js). Output passes a strict linter before it is
 * allowed anywhere near the render path; on failure we run ONE repair round,
 * then fall back to the fixed-template renderer (graceful degradation — a
 * scene never ships empty).
 *
 *   authorComposition(brief)            — one scene -> validated composition | null
 *   authorCompositions(scenes, ctx)     — batch with cache
 *   validateComposition(raw, ns, dur)   — the linter (exported for tests)
 *
 * Caching: .hf-authored-cache.json in the project dir, keyed by a content
 * hash of the brief — rebuilds don't re-pay AI calls unless the scene changed.
 * Flags: HF_TEMPLATE_AUTHOR=0 disables. HF_AUTHOR_TASKTYPE routes the model.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');
const { callAI } = require('../brain/ai-provider');
const { generateDesignDoc } = require('./hf-design-doc');
let renderDirectivesBlock = () => '';
try { ({ renderDirectivesBlock } = require('../directives/directive-compiler')); } catch (_) { /* optional */ }

// Film-FX vocabulary, so the Composition Author chooses a scene's cinematic finish as
// part of the SAME creative act as its layout + motion (one human-editor decision). The
// footage FX director still owns real-clip scenes; the author owns its authored comps.
let EFFECT_IDS = [], GRADE_IDS = [];
try { ({ EFFECT_IDS, GRADE_IDS } = require('./hf-effects')); } catch (_) { /* registry optional */ }

const SKILL_DIR = path.join(__dirname, '..', '..', 'skills', 'hyperframes-template');

let _skillCache = null;
function loadSkill() {
    if (_skillCache) return _skillCache;
    const read = (f) => { try { return fs.readFileSync(path.join(SKILL_DIR, f), 'utf8'); } catch (_) { return ''; } };
    _skillCache = { skill: read('SKILL.md'), houseStyle: read('house-style.md') };
    return _skillCache;
}

function isDisabled() {
    return /^(0|false|off|no)$/i.test(String(process.env.HF_TEMPLATE_AUTHOR || '').trim());
}

// ── Validator (the load-bearing part) ──────────────────────────────────────

const FORBIDDEN_JS = /\b(setTimeout|setInterval|requestAnimationFrame|fetch|XMLHttpRequest|WebSocket|eval|Function\s*\(|import\s|document\.write|innerHTML|outerHTML|location|window\s*\.|globalThis|addEventListener|onComplete|onUpdate|onStart|ScrollTrigger|Math\.random|Date\.now|new\s+Date)\b/;
const FORBIDDEN_HTML_TAGS = /<\s*(script|style|link|iframe|object|embed|form|input|button|video|audio|source)\b/i;
const EVENT_ATTR = /\son[a-z]+\s*=/i;
const GSAP_TRANSFORM_PROPS = new Set([
    'x', 'y', 'z', 'xPercent', 'yPercent',
    'scale', 'scaleX', 'scaleY',
    'rotation', 'rotationX', 'rotationY', 'rotate', 'rotateX', 'rotateY',
    'skewX', 'skewY', 'transform',
]);

// GSAP resolves targets through querySelectorAll, which cannot address a CSS
// pseudo-element, and a blank string addresses nothing at all. Either way the
// tween is dead on arrival and only ever shows up as "GSAP target ... not
// found". Treated as "not a target" here so the audit below neither reports
// nor re-emits one.
const DEAD_TWEEN_TARGET = /::|:(?:before|after|first-line|first-letter|selection|placeholder|backdrop|marker)\b/i;

function isDeadTweenTarget(value) {
    if (typeof value !== 'string') return true;
    if (!value.trim()) return true;
    return DEAD_TWEEN_TARGET.test(value);
}

function timelineTargets(target) {
    if (typeof target === 'string') return isDeadTweenTarget(target) ? [] : [target];
    if (Array.isArray(target)) return target.filter(value => !isDeadTweenTarget(value));
    return [];
}

function resolveTimelinePosition(value, state) {
    if (value == null) return state.cursor;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const text = String(value).trim();
    const direct = Number(text);
    if (Number.isFinite(direct)) return direct;
    if (text === '<') return state.lastStart;
    if (text === '>') return state.lastEnd;
    const relative = text.match(/^([<>])?([+-]=)(-?\d+(?:\.\d+)?)$/);
    if (!relative) return NaN;
    const base = relative[1] === '<'
        ? state.lastStart
        : (relative[1] === '>' ? state.lastEnd : state.cursor);
    return base + (relative[2] === '+=' ? 1 : -1) * Number(relative[3]);
}

function tweenDurationSeconds(method, target, vars) {
    if (method === 'set' || method === 'gsap.set') return 0;
    const baseDuration = Number.isFinite(Number(vars?.duration))
        ? Math.max(0, Number(vars.duration))
        : 0.5;
    const repeat = Number(vars?.repeat);
    if (repeat === -1) return Infinity;
    const repeats = Number.isFinite(repeat) ? Math.max(0, repeat) : 0;
    const repeatDelay = Number.isFinite(Number(vars?.repeatDelay))
        ? Math.max(0, Number(vars.repeatDelay))
        : 0;
    const targets = timelineTargets(target);
    const stagger = vars?.stagger;
    let staggerTail = 0;
    if (targets.length > 1 && stagger != null) {
        if (Number.isFinite(Number(stagger))) {
            staggerTail = Math.abs(Number(stagger)) * (targets.length - 1);
        } else if (stagger && typeof stagger === 'object') {
            if (Number.isFinite(Number(stagger.amount))) {
                staggerTail = Math.abs(Number(stagger.amount));
            } else if (Number.isFinite(Number(stagger.each))) {
                staggerTail = Math.abs(Number(stagger.each)) * (targets.length - 1);
            }
        }
    }
    return baseDuration * (repeats + 1) + repeatDelay * repeats + staggerTail;
}

// The sandbox budget below is a runaway-loop guard, and nothing else. Getting
// its size right turned out to matter a great deal, because it had been sized
// against the wrong thing.
//
// Measured on the real authored timelines this project ships: inspecting one
// costs ~2ms of actual work. The budget was 100ms, which reads like 50x
// headroom. It isn't — `vm.runInNewContext`'s timeout is WALL-CLOCK, and the
// first call in a process also pays for V8 building a fresh context. Measured
// cost of that one-off, same machine, same input:
//
//     idle                    3 - 29 ms
//     all 12 cores saturated  up to 92 ms
//     observed in the wild            425 ms
//
// So the budget sat inside the noise band of a cost that has nothing to do
// with the code being judged. When it lost that race the timeline was declared
// unsafe, and an authored graphic was dropped from the video — silently, on a
// busy machine, for no reason but scheduling. It surfaced as a verify gate
// that failed only when the full suite ran, which is exactly how a real
// intermittent bug looks when you meet it in a test first.
//
// Three layers, smallest cause first:
//   1. WARM_UP pays the context-creation cost once, at first use, outside any
//      budget. That removes the variance rather than hiding it behind a bigger
//      number, and it is the actual root cause.
//   2. The budget goes to 2s: ~1000x the real 2ms of work, still clear of the
//      worst cold start ever observed, and still trivially fast at catching a
//      genuine infinite loop next to a multi-minute render.
//   3. A timeout — and ONLY a timeout — is retried once. A transient stall
//      passes on the retry; real runaway code times out twice and is correctly
//      rejected. This is the belt to (1)'s braces: it makes a timeout mean
//      "this code is pathological" instead of "the machine was busy".
const TIMELINE_INSPECT_TIMEOUT_MS = 2000;
let _vmWarmed = false;
function warmTimelineSandbox() {
    if (_vmWarmed) return;
    _vmWarmed = true;
    // Cheapest possible script; we are buying the context, not the result.
    try { vm.runInNewContext('0', {}, { timeout: 10_000 }); } catch (_) { /* best effort */ }
}

function inspectAuthoredTimeline(timeline) {
    const calls = [];
    const errors = [];
    const state = { cursor: 0, lastStart: 0, lastEnd: 0 };
    let fakeTimeline = null;
    const record = (method, args) => {
        const vars = method === 'fromTo' ? (args[2] || {}) : (args[1] || {});
        const rawPosition = method === 'fromTo' ? args[3] : args[2];
        const start = method === 'gsap.set' ? 0 : resolveTimelinePosition(rawPosition, state);
        if (!Number.isFinite(start)) {
            errors.push(`timeline uses an unsupported/non-numeric position "${String(rawPosition)}"`);
            return fakeTimeline;
        }
        const span = tweenDurationSeconds(method, args[0], vars);
        if (!Number.isFinite(span)) {
            errors.push('timeline contains an infinite repeat');
            return fakeTimeline;
        }
        const end = start + span;
        calls.push({
            method,
            target: args[0],
            targets: timelineTargets(args[0]),
            vars,
            start,
            end,
        });
        if (method !== 'gsap.set') {
            state.lastStart = start;
            state.lastEnd = end;
            state.cursor = Math.max(state.cursor, end);
        }
        return fakeTimeline;
    };
    fakeTimeline = {
        to(...args) { return record('to', args); },
        fromTo(...args) { return record('fromTo', args); },
        set(...args) { return record('set', args); },
    };
    const fakeGsap = {
        set(...args) { record('gsap.set', args); },
    };
    warmTimelineSandbox();
    const errorFloor = errors.length;
    const runOnce = () => {
        // Fresh recording state per attempt. A timed-out attempt can have got
        // some way through the timeline first, so without this a retry would
        // double-count its calls and repeat any error it already recorded.
        calls.length = 0;
        errors.length = errorFloor;
        state.cursor = 0; state.lastStart = 0; state.lastEnd = 0;
        vm.runInNewContext(
            `(function(tl, gsap){\n${timeline}\n})(tl, gsap);`,
            { tl: fakeTimeline, gsap: fakeGsap },
            {
                timeout: TIMELINE_INSPECT_TIMEOUT_MS,
                codeGeneration: { strings: false, wasm: false },
            }
        );
    };
    try {
        runOnce();
    } catch (error) {
        // Only a timeout earns a second chance. A SyntaxError or a ReferenceError
        // is a fact about the code and will repeat, so retrying it would just be
        // slower on the way to the same answer.
        const timedOut = /timed out/i.test(String(error?.message || ''));
        let settled = error;
        if (timedOut) {
            try { runOnce(); settled = null; } catch (retryError) { settled = retryError; }
        }
        if (settled) {
            errors.push(`timeline could not be inspected safely: ${String(settled.message).slice(0, 100)}`);
        }
    }
    return {
        calls,
        errors,
        maxEnd: calls.reduce((max, call) => Math.max(max, call.end), 0),
    };
}

/**
 * A MEASURED motion fingerprint of an authored timeline.
 *
 * Two consumers, one measurement: the style ledger below phrases it as a
 * sentence for the next author to read, and the bridge stamps the raw numbers
 * onto its visual report so the sequence linter can judge whether the video's
 * graphics actually opened at different speeds. Those must never drift apart —
 * teaching the author one thing and grading it on another is how a fix comes
 * to look like it worked.
 *
 * The ledger already told the author to "vary STRUCTURE, anchor and motion",
 * and Step 4 measured what that instruction actually achieved: nothing. Every
 * graphic in the real 20-graphic build resolved to one speed, twenty times out
 * of twenty. The vocabulary existed; nothing spent it.
 *
 * The reason is visible in the ledger line itself — it carried the author's own
 * prose notes and nothing else. Prose is where a model describes what it MEANT
 * to do, and it never mentions timing, so "vary motion" was an instruction with
 * no evidence behind it. Asking harder would not have helped; the next author
 * genuinely could not see that its three siblings all opened at 0.6 seconds.
 *
 * So this reads the timeline the sibling actually shipped and states three
 * facts: how long its opening move takes, how many distinct beats it is
 * staggered across, and when all motion has settled. Measured, not
 * self-reported — the same reason the sequence linter counts rendered output
 * rather than trusting the plan.
 *
 * Never throws: a signature is a nicety, and an unparseable timeline is already
 * the linter's problem, not the ledger's.
 */
function measureAuthoredMotion(timelineCode) {
    if (!timelineCode) return null;
    let inspected;
    try { inspected = inspectAuthoredTimeline(String(timelineCode)); } catch (_) { return null; }
    const tweens = (inspected.calls || []).filter((c) => c.method === 'to' || c.method === 'fromTo');
    if (!tweens.length) return null;
    const opening = tweens.reduce((a, b) => (b.start < a.start ? b : a));
    return {
        openSpan: Math.max(0, opening.end - opening.start),
        // Distinct start times, quantised to 50ms: two tweens that start
        // together are one beat, not two, however many selectors they touch.
        beats: new Set(tweens.map((t) => Math.round(t.start * 20))).size,
        settle: Number(inspected.maxEnd || 0),
        ease: String(opening.vars?.ease ?? 'default').split('(')[0].trim() || 'default',
    };
}

/**
 * The same three facts, phrased for the ledger the next author reads.
 */
function motionSignature(timelineCode) {
    const m = measureAuthoredMotion(timelineCode);
    if (!m) return '';
    return `opens ${m.openSpan.toFixed(2)}s/${m.ease}, ${m.beats} beat${m.beats === 1 ? '' : 's'}, `
        + `settles by ${m.settle.toFixed(1)}s`;
}

function authoredTransformConflicts(css, calls) {
    const transforms = new Map();
    const cssNoComments = String(css || '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const match of cssNoComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const transform = match[2].match(/(?:^|;)\s*transform\s*:\s*([^;]+)/i)?.[1]?.trim();
        if (!transform || !/(?:translate|scale|rotate|skew)/i.test(transform)) continue;
        for (const selector of match[1].split(',').map(value => value.trim())) {
            if (/^[#.][a-zA-Z0-9_-]+$/.test(selector)) transforms.set(selector, transform);
        }
    }
    const conflicts = [];
    for (const call of calls) {
        if (call.method === 'fromTo') continue;
        if (!Object.keys(call.vars || {}).some(prop => GSAP_TRANSFORM_PROPS.has(prop))) continue;
        for (const selector of call.targets) {
            const transform = transforms.get(selector);
            if (transform) conflicts.push({ selector, transform });
        }
    }
    return conflicts.filter((entry, index, all) => (
        all.findIndex(other => other.selector === entry.selector) === index
    ));
}

function normalizeAuthoredTimeline(timeline, duration) {
    const source = String(timeline || '').trim();
    if (!source) return source;
    const audit = inspectAuthoredTimeline(source);
    if (audit.errors.length) return source;
    const additions = [];
    const existingHardKills = [];
    const lastExitBySelector = new Map();
    for (const call of audit.calls) {
        const hidden = Number(call.vars?.opacity) === 0
            || Number(call.vars?.autoAlpha) === 0
            || String(call.vars?.visibility || '').toLowerCase() === 'hidden'
            || String(call.vars?.display || '').toLowerCase() === 'none';
        for (const selector of call.targets) {
            if (call.method === 'set' && hidden) {
                existingHardKills.push({ selector, at: call.start });
            } else if ((call.method === 'to' || call.method === 'fromTo') && hidden) {
                const previous = lastExitBySelector.get(selector);
                if (!previous || call.end >= previous.end) lastExitBySelector.set(selector, call);
            }
        }
    }
    const clipDuration = Math.max(0, Number(duration) || 0);
    for (const [selector, exit] of lastExitBySelector) {
        if (exit.end < 0 || (clipDuration > 0 && exit.end > clipDuration + 0.05)) continue;
        const at = Math.max(0, Math.min(clipDuration || exit.end, exit.end));
        const alreadyKilled = existingHardKills.some(kill => (
            kill.selector === selector && Math.abs(kill.at - at) <= 0.06
        ));
        if (alreadyKilled) continue;
        additions.push(`tl.set(${JSON.stringify(selector)}, { opacity: 0, visibility: "hidden" }, ${at.toFixed(3)});`);
    }
    return additions.length
        ? `${source}\n\n// Seek-safe exit hard kills (injected by the author validator).\n${additions.join('\n')}`
        : source;
}

/**
 * rescueComposition — apply the deterministic repairs, or return null.
 *
 * Thin on purpose. The edits and their per-rule verification live in
 * hf-author-repair.js; this only decides WHEN to offer them and re-measures the
 * timeline afterwards, because the overrun figure comes from this file's own
 * inspector and must be the same number the validator will use a moment later.
 *
 * Never throws and never partially applies: a repair that cannot be proved to
 * have worked is dropped, leaving the composition byte-for-byte as the author
 * wrote it and the AI repair round to deal with it as before.
 */
function rescueComposition(parsed, brief) {
    if (!parsed || typeof parsed !== 'object') return null;
    let repair;
    try { repair = require('./hf-author-repair'); } catch (_) { return null; }

    const fixes = [];
    let css = String(parsed.css || '');
    let timeline = String(parsed.timeline || '');

    try {
        let theme = null;
        try {
            const { getThemeTokens } = require('../data/themes');
            theme = brief.themeId ? getThemeTokens(brief.themeId) : null;
        } catch (_) { /* theme optional — the universal rules still apply */ }
        const styled = repair.repairStyle(
            { html: String(parsed.html || ''), css, timeline },
            { theme, themeId: brief.themeId, kind: brief.kind }
        );
        if (styled && styled.fixes.length) {
            css = styled.css;
            // Easing lives in the timeline, so the repair returns both halves.
            if (typeof styled.timeline === 'string') timeline = styled.timeline;
            fixes.push(...styled.fixes);
        }
    } catch (_) { /* a failed repair is the same as no repair */ }

    try {
        const duration = Number(brief.duration);
        const audit = inspectAuthoredTimeline(timeline);
        if (!audit.errors.length && Number.isFinite(duration) && audit.maxEnd > duration + 0.03) {
            const scaled = repair.scaleTimelineToFit(timeline, duration, audit.maxEnd);
            if (scaled) {
                // Re-measure rather than trust the arithmetic: the validator is
                // about to measure it the same way, and a rescue that only
                // looks right is worse than none.
                const after = inspectAuthoredTimeline(scaled.timeline);
                if (!after.errors.length && after.maxEnd <= duration + 0.03) {
                    timeline = scaled.timeline;
                    fixes.push(`compressed a ${audit.maxEnd.toFixed(2)}s timeline onto its ${duration.toFixed(2)}s scene`);
                }
            }
        }
    } catch (_) { /* unparseable timeline is the validator's to report */ }

    if (!fixes.length) return null;
    return { parsed: { ...parsed, css, timeline }, fixes };
}

// ── Spoken numbers → digits ────────────────────────────────────────────────
// The numeric whitelist below compares what is drawn on screen against what
// the brief contains. The brief's biggest field is NARRATION, which is a
// spoken script: it says "three and a half", never "3.5". Comparing digits to
// digits therefore rejected the exact facts the rule exists to protect — on
// the 2026-08-05 build "3.5", "60" and "40" were all narration facts thrown
// out as model invention, and each rejection cost a whole bespoke design.
// This expands spelled forms to their digit value so a legitimate fact can be
// typeset as a numeral. It only ever ADDS to the allow-list.
const _NUM_WORDS = {
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
    ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
    seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fourty: 40,
    fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const _NUM_SCALES = { thousand: 1e3, million: 1e6, billion: 1e9, trillion: 1e12 };
const _NUM_FRACTIONS = { half: 0.5, halves: 0.5, quarter: 0.25, quarters: 0.25, third: 1 / 3, thirds: 1 / 3 };
const _NUM_FILLER = new Set(['and', 'a', 'an']);

function spelledNumbersIn(text) {
    const out = new Set();
    const toks = String(text || '').toLowerCase().match(/[a-z]+/g) || [];
    let scaled = 0, group = 0, frac = 0, decimals = '', active = false, inDecimal = false;
    const flush = () => {
        if (active) {
            let total = scaled + group + frac;
            if (decimals) total = Number(`${Math.trunc(total)}.${decimals}`);
            if (Number.isFinite(total) && total > 0) {
                // 3.5 stays "3.5"; 2500 stays "2500" (the caller strips commas
                // on both sides, so no comma variant is needed).
                out.add(String(Number(total.toFixed(4))));
            }
        }
        scaled = 0; group = 0; frac = 0; decimals = ''; active = false; inDecimal = false;
    };
    for (const t of toks) {
        if (active && _NUM_FILLER.has(t)) continue;
        if (active && t === 'point') { inDecimal = true; continue; }
        if (_NUM_WORDS[t] != null) {
            if (inDecimal) decimals += String(_NUM_WORDS[t]);
            else group += _NUM_WORDS[t];
            active = true;
            continue;
        }
        if (t === 'hundred') { group = (group || 1) * 100; active = true; inDecimal = false; continue; }
        if (_NUM_SCALES[t]) {
            // The fraction belongs to the mantissa: "three and a half million"
            // is 3.5 million, not three million and a half.
            const mantissa = (group + frac) || 1;
            // A big number is as legitimately typeset "3.5M" as "3,500,000",
            // so both readings go on the allow-list.
            if (group + frac > 0) out.add(String(Number((group + frac).toFixed(4))));
            scaled += mantissa * _NUM_SCALES[t];
            group = 0; frac = 0; active = true; inDecimal = false;
            continue;
        }
        if (_NUM_FRACTIONS[t] != null && active) { frac += _NUM_FRACTIONS[t]; continue; }
        flush();
    }
    flush();
    return out;
}

function validateComposition(raw, ns, duration, assets = [], brief = null) {
    const errors = [];
    // assets may be strings (legacy) or {token,path,kind,desc} objects (v9
    // asset pipe) — the allowed src/url values are the tokens.
    assets = (assets || []).map(a => (a && typeof a === 'object') ? String(a.token || '') : String(a)).filter(Boolean);
    if (!raw || typeof raw !== 'object') return { ok: false, errors: ['output is not a JSON object'] };
    const html = String(raw.html || '');
    const css = String(raw.css || '');
    const timeline = String(raw.timeline || '');

    if (!html.trim()) errors.push('html is empty');
    if (!timeline.trim()) errors.push('timeline is empty');
    if (html.length > 10000) errors.push(`html too large (${html.length} > 10000)`);
    if (css.length > 9000) errors.push(`css too large (${css.length} > 9000)`);
    if (timeline.length > 9000) errors.push(`timeline too large (${timeline.length} > 9000)`);

    // HTML rules
    if (FORBIDDEN_HTML_TAGS.test(html)) errors.push('html contains a forbidden tag (script/style/link/iframe/media/form)');
    if (EVENT_ATTR.test(html)) errors.push('html contains an inline event handler attribute');
    if (/<\s*(html|head|body)\b/i.test(html)) errors.push('html must be a fragment (no html/head/body)');
    // every id= must be namespaced
    for (const m of html.matchAll(/\bid\s*=\s*"([^"]*)"/g)) {
        if (!m[1].startsWith(ns)) errors.push(`id "${m[1]}" not namespaced (must start with "${ns}")`);
    }
    // img src whitelist
    for (const m of html.matchAll(/<img[^>]*\bsrc\s*=\s*"([^"]*)"/gi)) {
        if (!assets.includes(m[1])) errors.push(`img src "${m[1]}" is not a provided asset`);
    }
    // External-URL check — but XML namespace declarations are NOT network
    // fetches: <svg xmlns="http://www.w3.org/2000/svg"> is mandatory SVG
    // syntax (and the skill encourages SVG accents). Strip xmlns attributes
    // before testing.
    const htmlNoXmlns = html.replace(/\bxmlns(?::[\w-]+)?\s*=\s*("[^"]*"|'[^']*')/gi, '');
    if (/https?:\/\//i.test(htmlNoXmlns)) errors.push('html references an external URL');

    // CSS rules
    if (/@import/i.test(css)) errors.push('css uses @import');
    for (const m of css.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi)) {
        const u = m[1].trim();
        if (!assets.includes(u) && !u.startsWith('data:')) errors.push(`css url(${u}) is not a provided asset`);
    }
    if (/https?:\/\//i.test(css)) errors.push('css references an external URL');
    // every rule's selectors must be namespaced
    const cssNoBody = css.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of cssNoBody.matchAll(/(^|\})\s*([^{}@]+)\{/g)) {
        const sels = m[2].split(',').map(s => s.trim()).filter(Boolean);
        for (const sel of sels) {
            if (!sel.includes(ns)) { errors.push(`css selector "${sel.slice(0, 60)}" not scoped to namespace`); break; }
        }
    }

    // Timeline rules.
    // IMPORTANT: strip comments AND string literals BEFORE the forbidden-API
    // test. Selector strings legitimately contain banned substrings — e.g. a
    // "location-card" scene's namespace is `auth13-location-card`, which made
    // \blocation\b match inside every selector and permanently reject the
    // composition (re-authored on every project open, failing forever).
    const jsStripped = timeline
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\/\/[^\n]*/g, ' ')
        .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
    if (FORBIDDEN_JS.test(jsStripped)) {
        const hit = jsStripped.match(FORBIDDEN_JS);
        errors.push(`timeline contains forbidden API: ${hit && hit[0]}`);
    }
    // Call-pattern whitelist: every `name(` or `obj.method(` occurrence must
    // be tl.to/tl.fromTo/tl.set/gsap.set. Robust to multi-line formatting and
    // blocks any function invocation the runtime contract doesn't allow.
    const ALLOWED_CALLS = new Set(['tl.to', 'tl.fromTo', 'tl.set', 'gsap.set']);
    for (const m of jsStripped.matchAll(/([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*\(/g)) {
        const callee = m[1].replace(/\s+/g, '');
        if (!ALLOWED_CALLS.has(callee)) {
            errors.push(`timeline calls non-whitelisted function: ${callee}()`);
            break;
        }
    }
    // selectors in timeline must be namespaced
    for (const m of timeline.matchAll(/["'](#[^"']+|\.[^"']+)["']/g)) {
        const sel = m[1];
        if (/^[#.]/.test(sel) && !sel.slice(1).startsWith(ns)) {
            errors.push(`timeline selector "${sel.slice(0, 50)}" not namespaced`);
            break;
        }
    }
    // The timeline must PARSE — a fragment with a syntax error (typically a
    // truncated response) would kill the entire page <script>, taking the
    // master timeline down with it. vm.Script compiles without executing.
    try {
        new vm.Script(`(function(tl, gsap){\n${timeline}\n})`);
    } catch (e) {
        errors.push(`timeline has a JavaScript syntax error: ${String(e.message).slice(0, 80)} (output may be truncated — make the timeline shorter)`);
    }
    if (!errors.some(error => error.includes('timeline has a JavaScript syntax error'))) {
        const audit = inspectAuthoredTimeline(timeline);
        errors.push(...audit.errors);
        if (Number.isFinite(Number(duration)) && audit.maxEnd > Number(duration) + 0.03) {
            errors.push(`timeline ends at ${audit.maxEnd.toFixed(2)}s, after the ${Number(duration).toFixed(2)}s scene duration`);
        }
        const conflicts = authoredTransformConflicts(css, audit.calls);
        for (const conflict of conflicts.slice(0, 3)) {
            errors.push(`"${conflict.selector}" has CSS transform "${conflict.transform}" but a tl.to/tl.set/gsap.set also animates transform properties; move centering to an unanimated wrapper or use tl.fromTo so GSAP owns the complete transform`);
        }
    }

    // Meta-label guard (human-not-AI, ENFORCED): printing the upstream type
    // tag as visible text ("KEY TAKEAWAY" eyebrow above the headline) is the
    // #1 AI-design tell. Generic for every type — only multi-word tags are
    // checked so single common words ("counter", "quote") can't false-match.
    if (brief && brief.type) {
        const typePhrase = String(brief.type).replace(/-/g, ' ').trim().toLowerCase();
        if (typePhrase.includes(' ')) {
            const visText = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').toLowerCase();
            if (visText.includes(typePhrase)) {
                errors.push(`on-screen text contains the internal type tag "${typePhrase}" — category/meta labels are forbidden; show only story content (see LOOK HUMAN rule)`);
            }
        }
    }

    // Numeric whitelist (factual safety, ENFORCED): every number displayed in
    // the html must come from the brief (narration/text/items). The
    // prompt rule alone was violated in production — the agent shipped
    // "193KM", "opened 1869", "~50 ships/day" from model knowledge. Small
    // integers (≤12: list counts, ordinals) are exempt.
    if (brief) {
        const allowedPool = [brief.text, brief.subtext, brief.narration,
            ...(brief.items || []).map(i => `${i.label || ''} ${i.value || ''}`)].join(' ');
        const allowedNums = new Set((allowedPool.match(/\d[\d,.]*/g) || []).map(n => n.replace(/[,.]+$/, '')));
        // The narration is spoken, so its numbers arrive as words.
        for (const n of spelledNumbersIn(allowedPool)) allowedNums.add(n);
        const htmlText = html.replace(/<[^>]+>/g, ' ');
        for (const m of (htmlText.match(/\d[\d,.]*/g) || [])) {
            const num = m.replace(/[,.]+$/, '');
            const plain = num.replace(/,/g, '');
            if (Number(plain) <= 12 && !plain.includes('.')) continue;
            if (allowedNums.has(num) || allowedNums.has(plain) || [...allowedNums].some(a => a.replace(/,/g, '') === plain)) continue;
            errors.push(`number "${m}" does not appear in the scene brief — facts must come from the narration, never your own knowledge (remove it or use a brief-sourced fact)`);
            break;
        }
    }

    return { ok: errors.length === 0, errors, html, css, timeline, notes: String(raw.notes || '') };
}

// ── Prompt assembly ────────────────────────────────────────────────────────

function buildPrompt(brief, design, repairErrors = null, prevOutput = null, ledger = null) {
    const { skill, houseStyle } = loadSkill();
    const assets = brief.assets || [];
    const normalizedBriefType = String(brief.type || '')
        .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
        .replace(/[_\s]+/g, '-')
        .toLowerCase();
    const focusWordOverlay = brief.kind === 'overlay' && normalizedBriefType === 'focus-word';
    const overlayFrameRule = brief.kind === 'overlay'
        ? (focusWordOverlay
            ? 'OVERLAY FRAME POLICY: this is a focus-word emphasis beat. Keep your authored canvas transparent; the renderer may add one subtle full-frame focus shade behind it. Do not author a second scrim, vignette, tint, blur, or full-frame background.'
            : 'OVERLAY FRAME POLICY: the 1920x1080 canvas must stay fully transparent. Do not draw any full-frame background, side gradient, scrim, vignette, tint, blur, or shadow layer. Readability protection must be bounded tightly to the text/card content and the underlying footage must remain visually unchanged outside that local region.')
        : '';
    const parts = [
        skill,
        '\n---\n',
        houseStyle,
        '\n---\n',
        design,
        // Style ledger: what the OTHER compositions in this video already look
        // like. The single biggest AI tell is every graphic sharing one safe
        // silhouette — the ledger lets the author vary structure deliberately
        // while keeping the palette coherent.
        ledger && ledger.length
            ? `\n---\n# TREATMENTS ALREADY AUTHORED IN THIS VIDEO
Vary the look: do NOT repeat the same silhouette/plate construction as these. Keep the PALETTE consistent; vary STRUCTURE, anchor and motion. If two or more of these already sit on a filled rectangular plate, your composition MUST use a different construction (bare shadow-text + underline, frosted glass, leader line, oversized numeral, ticker strip, bracket frame, …).
The [bracketed] part of each line is MEASURED from the timeline that sibling actually shipped — it is not a description, it is what the viewer will see. Read it before you choose your own pace:
  - PACE IS EDITORIAL, NOT A DEFAULT. A hard statistic can snap in; a quote can settle slowly; a turning point can hold and then move. If the openings below are all within about 0.15s of each other, yours must be clearly outside that cluster — faster or slower, chosen because THIS beat wants it.
  - BEATS ARE STRUCTURE. A composition that lands everything in one beat reads as a slide; one staggered across three or four reads as edited. Vary how many beats you use, not just how long they take.
  - Nothing here licenses slow. A graphic that has not settled well before its scene ends is a defect, not a choice.
${ledger.slice(-10).map(l => `  - ${l}`).join('\n')}`
            : '',
        '\n---\n# SCENE BRIEF\n',
        `NAMESPACE: ${brief.ns}`,
        `DURATION: ${brief.duration.toFixed(2)} seconds`,
        `TIMELINE SAFETY: every tween must end by ${brief.duration.toFixed(2)}s. For every exit that fades or hides a selector, add a matching tl.set("same-selector", { opacity: 0, visibility: "hidden" }, EXIT_END_TIME) hard kill at the exact exit end so nonlinear seeking cannot resurrect it.`,
        'TRANSFORM OWNERSHIP: never combine a CSS transform (translate/scale/rotate) with tl.to(), tl.set(), or gsap.set() transform properties on the SAME selector. Put CSS centering on an unanimated wrapper, or remove the CSS transform and use tl.fromTo() so GSAP owns the complete transform.',
        `SCENE ROLE: ${brief.kind === 'overlay'
        ? 'OVERLAY floating on LIVE FOOTAGE — the footage stays visible and is the star; you annotate it, never replace it. OVERLAY MODE rules apply (transparent stage, coverage budget).'
        : brief.kind === 'fullscreen' ? 'full-screen graphic moment (replaces footage entirely)' : 'standalone full-screen editorial beat'}`,
        overlayFrameRule,
        'SEMANTIC ECONOMY: communicate each fact once. Never repeat the hero number/headline in a second lower third, footer, ticker, badge, chip, caption, or decorative data row inside the same composition.',
        brief.kind === 'overlay' && brief.position ? `POSITION: anchor the content in the "${brief.position}" zone of the 1920x1080 frame.` : '',
        brief.chainPrev ? `CHAIN CONTINUITY (IN): this graphic appears the INSTANT the previous graphic ("${brief.chainPrev.text}") ends — there is NO cut and the container does not animate. Design this as the NEXT PAGE of the same design system: a calm full-frame background built from the DESIGN base colors (no loud novel background construction), so the canvas appears continuous; let your CONTENT entrance carry the change. Skip heavy full-canvas entrance moves.` : '',
        brief.chainNext ? `CHAIN CONTINUITY (OUT): another graphic follows this one immediately with no cut. Exit your CONTENT cleanly by the end, but keep the background calm and full-frame to the last frame (built from DESIGN base colors) — the next page lands on it.` : '',
        renderDirectivesBlock(brief.directives, 'composition'),
        brief.type ? `UPSTREAM SUGGESTION (non-binding, INTERNAL — never render this tag or any category label as on-screen text): the selector tagged this "${brief.type}" — treat it as a hint about the content's nature, NOT a layout to follow. YOU decide the treatment from the narration and data.` : '',
        `HEADLINE / TEXT: ${brief.text || '(none — derive from narration)'}`,
        brief.subtext ? `SUPPORTING TEXT: ${brief.subtext}` : '',
        brief.items && brief.items.length
            ? `DATA ITEMS:\n${brief.items.map(it => `  - ${it.label || ''}${it.value ? ` = ${it.value}` : ''}`).join('\n')}`
            : '',
        brief.narration ? `NARRATION (what the voiceover says during this scene): ${brief.narration}` : '',
        assets.length
            ? `ASSETS — real local images you MAY place in the composition. Use the token EXACTLY as the src/url value (the system substitutes the real file at render). Always cover-fit (object-fit:cover or background-size:cover), never stretch; ${brief.kind === 'overlay' ? 'use images only as bounded local graphic elements and never redraw or darken the full footage frame' : 'put a darkening scrim under any text that sits on a photo'}:\n${assets.map(a => (a && typeof a === 'object') ? `  - ${a.token} (${a.kind}): ${a.desc || 'scene media'}` : `  - ${a}`).join('\n')}`
            : (brief.kind === 'overlay'
                ? 'ASSETS: none — keep the full canvas transparent and build only the bounded text/graphic elements.'
                : 'ASSETS: none — build a designed CSS background.'),
        // FILM FINISH — same creative act as layout + motion. The author picks the cinematic
        // grade/texture for THIS scene from the engine's hand-tuned registry (it never writes
        // FX CSS itself — it prescribes ids the renderer realizes), so a scene's look is one
        // coherent decision instead of layout-then-bolt-on-grade.
        EFFECT_IDS.length
            ? `\n# FILM FINISH (you also choose this scene's cinematic look — one creative act with the layout + motion above)
Prescribe 0-3 texture/light effects + optionally ONE color grade that serve THIS scene's MOOD and the theme. Less is more — clean (none) is valid for crisp data beats; match the video's palette, don't make every scene loud. Use ids EXACTLY.
EFFECT ids: ${EFFECT_IDS.join(', ')}
GRADE ids (at most one): ${GRADE_IDS.join(', ')}
ERA looks (vintageFrame, filmScratches, oldTv, vhs, staticNoise) ONLY for past/archival/flashback content; at most one era family across the whole video. intensity 0.15-0.45 for a base look, 0.5-0.8 only for a deliberate dramatic beat.`
            : '',
        '\nRespond in EXACTLY this delimited format (no markdown fences, no JSON except the EFFECTS array):',
        `===HTML===\n(the html fragment)\n===CSS===\n(the css)\n===TIMELINE===\n(the gsap tween calls)${EFFECT_IDS.length ? '\n===EFFECTS===\n(a JSON array of {"id","intensity"} entries + optional {"id":"<grade>"}, e.g. [{"id":"grain","intensity":0.3},{"id":"teal-orange"}] — or [] for a clean finish)' : ''}\n===NOTES===\n(your 2-4 sentence design reasoning)`,
    ];
    if (repairErrors) {
        parts.push('\n# REPAIR ROUND\nYour previous output was rejected by the linter. Fix ONLY these violations and resend the FULL corrected output in the same ===SECTION=== format:');
        parts.push(repairErrors.map(e => `  - ${e}`).join('\n'));
        if (prevOutput) parts.push(`\nYour previous output (truncated):\n${JSON.stringify(prevOutput).slice(0, 3000)}`);
    }
    return parts.filter(Boolean).join('\n');
}

// Parse + validate the author's prescribed film-FX recipe against the registry vocabulary
// (same shape the FX director produces for footage scenes). Unknown ids dropped; never throws.
function _parseAuthoredEffects(raw) {
    if (!raw) return [];
    let t = String(raw).replace(/```(?:json)?/gi, '').trim();
    const start = t.indexOf('['); const end = t.lastIndexOf(']');
    if (start < 0 || end <= start) return [];
    let arr;
    try { arr = JSON.parse(t.slice(start, end + 1)); } catch (_) { return []; }
    if (!Array.isArray(arr)) return [];
    const valid = new Set([...(EFFECT_IDS || []), ...(GRADE_IDS || [])]);
    const clamp01 = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.4; };
    return arr
        .filter(e => e && valid.has(e.id))
        .slice(0, 4)
        .map(e => ({
            id: e.id,
            ...((GRADE_IDS || []).includes(e.id) ? {} : { intensity: clamp01(e.intensity) }),
            ...(e.warmth != null ? { warmth: clamp01(e.warmth) } : {}),
            ...(e.radius != null ? { radius: clamp01(e.radius) } : {}),
        }));
}

function parseAuthorResponse(text) {
    if (!text) return null;
    let t = String(text).trim();
    // Primary protocol: ===SECTION=== delimited blocks. Code-heavy payloads
    // break JSON escaping constantly (raw newlines/quotes inside html/css
    // strings) — delimited sections sidestep the whole failure class.
    const grab = (name) => {
        const re = new RegExp(`===\\s*${name}\\s*===\\s*([\\s\\S]*?)(?====\\s*[A-Z]+\\s*===|$)`, 'i');
        const m = t.match(re);
        if (!m) return null;
        // strip accidental code fences inside a section
        return m[1].replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/i, '').trim();
    };
    const html = grab('HTML');
    const css = grab('CSS');
    const timeline = grab('TIMELINE');
    if (html != null && timeline != null) {
        return { html, css: css || '', timeline, notes: grab('NOTES') || '', effects: _parseAuthoredEffects(grab('EFFECTS')) };
    }
    // Legacy fallback: a single JSON object.
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try { return JSON.parse(t.slice(start, end + 1)); } catch (_) { /* try repair */ }
    try { return JSON.parse(t.slice(start, end + 1).replace(/\r?\n/g, '\\n')); } catch (_) { return null; }
}

// ── Cache ──────────────────────────────────────────────────────────────────

// Bump when SKILL.md / house-style.md / prompt structure / routing changes —
// invalidates cached compositions authored under the old playbook.
// NOTE: the v5→lint-fix change (strip strings before forbidden-API test) is
// purely more permissive — previously-cached good compositions remain valid,
// so the version is intentionally NOT bumped (a bump would re-author all 18
// scenes for nothing). Bump only when prompt/skill/output contract changes.
// v8: LOOK HUMAN rule — eyebrow/category labels banned (skill + lint), kicker
// field removed from briefs. Bump forces re-author of all cached comps.
// v9: media asset pipe — briefs carry __HF_ASSET_i__ image tokens (subject
// photos / nearby footage frames); skill gains media-treatment playbook.
// v10: entrance guard — timelines must open with gsap.set initial states
// (frame 0 = entrance start, not finished layout); visual lint measures t=0.
// v11: variety — style ledger in prompt (siblings' treatments), VARIETY
// skill rules + overlay treatment repertoire. Same-silhouette = failure mode.
// v12: perfectionist — vision art-director reviews the rendered hero frame
// (APPROVE / ≤3 concrete visual fixes), one refine round, no regression.
// v13: author-fx — the author also prescribes the scene's film finish (FX recipe +
// grade) as one creative act with layout + motion; ===EFFECTS=== section added.
// v17: theme contract — every authored comp is now checked against the slop
// rules AND against what THIS video's theme declares (faces, palette, corner
// radius), in the repair round and again after the art-director refine. The
// version bumps because a cached comp was accepted by a weaker linter, and a
// cache that outlives the gate that validated it is how a fix quietly undoes
// itself. Measured before bumping: 0 of 92 cached comps on the live project
// fail the new rules, so in practice this re-bills nothing that was passing.
// v18: measured motion in the style ledger. Step 4 measured that animation
// speed never varied — 20 graphics out of 20 at one speed — while the ledger
// was already telling the author to "vary motion". The instruction had no
// evidence behind it, because the ledger carried only the author's own prose.
// Each ledger line now leads with the sibling's MEASURED opening span, beat
// count and settle time, and the prompt tells the author how to read it.
// The version bumps because this is a prompt-structure change whose whole
// purpose is to change the output: leaving it unbumped would serve every
// existing project its old, uniformly-paced comps from cache and the fix
// would appear to do nothing on the next real build. That is the opposite of
// the v5 case, which was left unbumped precisely because it could not change
// a passing composition.
// v19: convergence. Two things were costing whole designs for reasons that had
// nothing to do with design quality. (1) The gates ran in sequence and stopped
// at the first one that fired, so a round taught the author about exactly one
// rule; with two rounds, a composition that broke two rules was mathematically
// unable to survive. (2) The numeric guard compared on-screen digits against a
// SPOKEN narration, so "3.5" was rejected as invention when the script said
// "three and a half". Both are fixed here, the deterministic repair list grew
// from 4 fixes to cover every mechanically-correctable rule, and the rendered
// frame is now measured for real contrast. The version bumps because the whole
// point is to change the output: 8 of 18 fullscreen graphics on the 2026-08-05
// build were binned, and leaving the salt alone would serve those same failures
// from cache on the next build.
const AUTHOR_VERSION = 'v19-convergent-rounds';

// Repair rounds. Raise for a stubborn project; 1 disables repair entirely.
const MAX_AUTHOR_ROUNDS = (() => {
    const n = parseInt(String(process.env.HF_AUTHOR_ROUNDS || '').trim(), 10);
    return Number.isFinite(n) && n >= 1 && n <= 8 ? n : 4;
})();

// Kill switch for the retry-a-failed-brief behaviour below. Default OFF (i.e.
// retries ARE on) — it exists so a build can be made cheap and reproducible on
// demand, not because caching a failure forever was ever the right default.
const RETRY_FAILED_OFF = /^(0|false|off|no)$/i.test(String(process.env.HF_AUTHOR_RETRY_FAILED || '').trim());

function briefHash(brief, design) {
    const key = JSON.stringify({
        v: AUTHOR_VERSION,
        ns: brief.ns, d: Math.round(brief.duration * 10), t: brief.text, s: brief.subtext,
        i: brief.items, k: brief.kind, ty: brief.type, n: brief.narration, a: brief.assets, dg: design.length,
        p: brief.position || '',
        co: `${brief.chainPrev ? 'p' : ''}${brief.chainNext ? 'n' : ''}`,
        // Creator directives change the composition prompt → must bust the cache.
        dir: brief.directives ? (renderDirectivesBlock(brief.directives, 'composition') || '') : '',
    });
    return crypto.createHash('sha1').update(key).digest('hex').slice(0, 16);
}

function loadCache(projectDir) {
    try { return JSON.parse(fs.readFileSync(path.join(projectDir, '.hf-authored-cache.json'), 'utf8')); } catch (_) { return {}; }
}
function saveCache(projectDir, cache) {
    try { fs.writeFileSync(path.join(projectDir, '.hf-authored-cache.json'), JSON.stringify(cache)); } catch (_) { /* non-fatal */ }
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Author one composition. brief = { ns, duration, kind, type, text, subtext,
 * items, narration, assets, themeId, nicheId, styleProfile }.
 * Returns { html, css, timeline, notes, authored:true } or null (caller falls
 * back to the fixed renderer).
 */
async function authorComposition(brief, opts = {}) {
    if (isDisabled()) return null;
    const log = typeof opts.log === 'function' ? opts.log : (m) => console.log(m);
    const design = generateDesignDoc({ themeId: brief.themeId, styleProfile: brief.styleProfile, nicheId: brief.nicheId });
    // 'brain' routes to the reasoning model (plannerTaskTypes → bedrock
    // plannerModel, currently Claude Sonnet). Composition design is a
    // reasoning task first, codegen second — don't send it to the workhorse.
    const taskType = process.env.HF_AUTHOR_TASKTYPE || 'brain';
    const ledger = Array.isArray(opts.ledger) ? opts.ledger : null;

    let prompt = buildPrompt(brief, design, null, null, ledger);
    let parsed = null;
    let result = null;
    let unresolved = [];
    for (let round = 0; round < MAX_AUTHOR_ROUNDS; round++) {
        let text;
        try {
            text = await callAI(prompt, { maxTokens: 8000, temperature: 0.5, taskType });
        } catch (e) {
            log(`  ⚠️ [Author] AI call failed (${brief.ns}): ${String(e.message || e).slice(0, 120)}`);
            return null;
        }
        parsed = parseAuthorResponse(text);
        if (!parsed) {
            log(`  ⚠️ [Author] unparseable response (${brief.ns}, round ${round + 1})`);
            unresolved = ['response was not in the required ===SECTION=== format'];
            prompt = buildPrompt(brief, design, unresolved, null, ledger);
            continue;
        }
        // ── Deterministic rescue ──
        // Fix the violations that have exactly one correct answer BEFORE
        // spending a round on them. A round is expensive in a way that is easy
        // to miss: there are only two, so a composition rejected twice is
        // thrown away entirely and a hardcoded built-in card is rendered
        // instead. In the 2026-08-04 build a 0.16s timeline overrun and a 3px
        // border each cost a whole bespoke design that way.
        //
        // Nothing here is trusted on its word — every repair is verified
        // against the live rule that rejected it, and the full validator runs
        // on the result below exactly as it would have on the raw output.
        const rescue = rescueComposition(parsed, brief);
        if (rescue) {
            parsed = rescue.parsed;
            log(`  🔧 [Author] auto-fixed ${brief.ns} (round ${round + 1}): ${rescue.fixes.join('; ')}`);
        }

        // ── EVERY GATE, ONE ROUND ──
        // The gates used to run in sequence and bail on the first one that
        // fired, so a round only ever taught the author about a single rule.
        // With two rounds that is a coin flip the author loses: round 1
        // rejected a colour, round 2 fixed the colour and was rejected for an
        // easing curve, and the design was thrown away. Measured on the
        // 2026-08-05 build — 8 of 18 fullscreen graphics died exactly that
        // way, every one of them on a DIFFERENT rule the second time.
        //
        // Now all three run every round and their findings are merged into one
        // repair brief, so the author fixes the whole composition at once
        // instead of trading one violation for the next.
        result = validateComposition(parsed, brief.ns, brief.duration, brief.assets || [], brief);
        const roundErrors = [];
        if (result.ok) result.timeline = normalizeAuthoredTimeline(result.timeline, brief.duration);
        else roundErrors.push(...result.errors.slice(0, 8));

        // ── Slop + theme contract ──
        // Deterministic, free and textual, so it runs whatever the structural
        // verdict was. The contract half asks the question the universal rules
        // cannot — not "is this a cliché?" but "does this belong to THIS
        // video?" — and it is inert without a theme, so a brief with no
        // themeId degrades to the universal rules rather than failing.
        if (!/^(0|false|off|no)$/i.test(String(process.env.HF_THEME_CONTRACT || '').trim())) {
            try {
                const { slopLint } = require('./hf-slop-lint');
                const { getThemeTokens } = require('../data/themes');
                const theme = brief.themeId ? getThemeTokens(brief.themeId) : null;
                const slop = slopLint(
                    { html: result.html, css: result.css, timeline: result.timeline },
                    { theme, kind: brief.kind, source: 'composition' }
                );
                if (!slop.ok) roundErrors.push(...slop.errors.slice(0, 6));
            } catch (sErr) {
                log(`  🎨 [Author] slop lint unavailable (${String(sErr.message).slice(0, 60)}) — skipped`);
            }
        }

        // MEASURE the rendered pixels. Frame overflow, text collisions,
        // unreadable contrast and invisible-at-hero-frame elements come back
        // as concrete errors the repair round can act on. Only worth doing
        // when the structure parses — a timeline with a syntax error renders
        // nothing, and its complaints would just echo the errors above.
        if (result.ok) {
            try {
                const { visualLint } = require('./hf-visual-lint');
                const vis = await visualLint({ html: result.html, css: result.css, timeline: result.timeline }, brief.ns, brief.duration, { kind: brief.kind, themeId: brief.themeId });
                if (!vis.ok) roundErrors.push(...vis.errors.slice(0, 6));
            } catch (vErr) {
                log(`  📐 [Author] visual lint unavailable (${String(vErr.message).slice(0, 60)}) — textual lint only`);
            }
        }

        if (result.ok && !roundErrors.length) break;

        unresolved = roundErrors.length ? roundErrors : (result.errors || []);
        log(`  🛠️ [Author] round ${round + 1}/${MAX_AUTHOR_ROUNDS} rejected ${brief.ns} (${unresolved.length} issue${unresolved.length === 1 ? '' : 's'}): ${unresolved.slice(0, 3).join(' | ')}`);
        prompt = buildPrompt(brief, design, unresolved.slice(0, 12), parsed, ledger);
        result = null;
    }
    // Still rejected after every round. The marker is returned so the batch
    // layer can record it, but it means "this sample failed", not "this brief
    // is impossible": see authorCompositions, where a build always retries a
    // previously-failed brief and only the zero-AI open mode honours the
    // marker. Logging every unresolved rule (not just the first) is what makes
    // a failure diagnosable from the build log alone.
    if (!result || !result.ok) {
        log(`  ❌ [Author] ${brief.ns} unresolved after ${MAX_AUTHOR_ROUNDS} rounds: ${unresolved.slice(0, 6).join(' | ')}`);
        return { failed: true, reason: unresolved.slice(0, 6) };
    }

    // ── Perfectionist pass (HF_AUTHOR_PERFECTIONIST=0 disables) ──
    // Lints catch violations; they can't catch "passes every rule but looks
    // mediocre". Render the hero frame, have the VISION chain review it like
    // an art director, and give the author ONE refine round on the critique.
    // The refined version must re-pass every lint or we keep the original —
    // perfectionism never regresses a valid comp.
    if (!/^(0|false|off|no)$/i.test(String(process.env.HF_AUTHOR_PERFECTIONIST || '').trim())) {
        try {
            const { captureHeroFrame, visualLint } = require('./hf-visual-lint');
            const frame = await captureHeroFrame(result, brief.ns, brief.duration, { themeId: brief.themeId });
            if (!frame) {
                log(`  🎭 [Author] perfectionist pass skipped for ${brief.ns} — hero frame capture unavailable`);
                result._review = 'skipped';
            }
            if (frame) {
                const { callVisionAI } = require('../brain/ai-provider');
                const critique = await callVisionAI(
                    `You are a broadcast art director reviewing ONE frame of a motion graphic (the "hero frame" of a ${brief.duration.toFixed(1)}s ${brief.kind} scene for a YouTube video).\n`
                    + `The scene's content: "${String(brief.text || brief.narration || '').slice(0, 140)}"\n\n`
                    + `Judge ONLY the visual craft: hierarchy (one dominant element?), balance and dead space, alignment rhythm, type sizing/contrast, whether it looks human-designed or AI-generated (category labels, generic centered box, cramped or floating-in-void layouts).\n`
                    + `Do NOT question the facts or the copy. Do NOT request new content.\n\n`
                    + `Critique discipline: each fix must NAME the exact element it applies to ("the headline", "the stat number", "the left panel"), never a vague whole-frame complaint; each fix must be a concrete actionable visual change. If you cannot state a concrete fix, reply APPROVE — do not block on vague dissatisfaction or mere polish.\n\n`
                    + `Reply EXACTLY one of:\n`
                    + `APPROVE\n`
                    + `REVISE: <up to 3 short, concrete, purely visual fixes — e.g. "headline 20% larger", "left-align the stack, kill the centered box", "supporting line too close to headline, double the gap">`,
                    frame, 'image/jpeg', { maxTokens: 160 }
                );
                const verdict = String(critique || '').trim();
                if (/^REVISE\s*:/i.test(verdict)) {
                    const notes = verdict.replace(/^REVISE\s*:/i, '').trim().slice(0, 400);
                    log(`  🎭 [Author] art director on ${brief.ns}: REVISE — ${notes.slice(0, 90)}`);
                    const refinePrompt = buildPrompt(brief, design, [
                        `ART DIRECTOR REVIEW of your rendered composition (visual critique of the actual frame — apply these, change nothing else): ${notes}`,
                    ], { html: result.html, css: result.css, timeline: result.timeline }, ledger);
                    try {
                        const text2 = await callAI(refinePrompt, { maxTokens: 8000, temperature: 0.4, taskType });
                        const parsed2 = parseAuthorResponse(text2);
                        if (parsed2) {
                            const refined = validateComposition(parsed2, brief.ns, brief.duration, brief.assets || [], brief);
                            if (refined.ok) {
                                refined.timeline = normalizeAuthoredTimeline(refined.timeline, brief.duration);
                                // The art director judges craft from a picture,
                                // so it can and does ask for a colour or a face
                                // by name. Re-running the contract here is what
                                // makes "must re-pass every lint" true: without
                                // it, the one round with no deterministic check
                                // is the round most likely to introduce drift.
                                let slop2 = { ok: true };
                                if (!/^(0|false|off|no)$/i.test(String(process.env.HF_THEME_CONTRACT || '').trim())) {
                                    try {
                                        const { slopLint } = require('./hf-slop-lint');
                                        const { getThemeTokens } = require('../data/themes');
                                        slop2 = slopLint(
                                            { html: refined.html, css: refined.css, timeline: refined.timeline },
                                            { theme: brief.themeId ? getThemeTokens(brief.themeId) : null, kind: brief.kind, source: 'composition' }
                                        );
                                    } catch (_) { slop2 = { ok: true }; }
                                }
                                const vis2 = slop2.ok
                                    ? await visualLint({ html: refined.html, css: refined.css, timeline: refined.timeline }, brief.ns, brief.duration, { kind: brief.kind, themeId: brief.themeId })
                                    : { ok: false };
                                if (vis2.ok) {
                                    log(`  🎭 [Author] ${brief.ns} refined per art-director notes`);
                                    return { html: refined.html, css: refined.css, timeline: refined.timeline, notes: refined.notes || result.notes, effects: Array.isArray(parsed2.effects) ? parsed2.effects : (parsed.effects || []), authored: true, review: 'revised' };
                                }
                            }
                        }
                        log(`  🎭 [Author] ${brief.ns} refinement failed lint — keeping the original (no regression)`);
                        result._review = 'kept-original';
                    } catch (e2) {
                        log(`  🎭 [Author] refine call failed (${String(e2.message || e2).slice(0, 80)}) — keeping the original`);
                        result._review = 'kept-original';
                    }
                } else if (verdict) {
                    log(`  🎭 [Author] art director on ${brief.ns}: APPROVED`);
                    result._review = 'approved';
                }
            }
        } catch (e) {
            log(`  🎭 [Author] perfectionist pass skipped (${String(e.message || e).slice(0, 70)})`);
            result._review = 'skipped';
        }
    }

    return { html: result.html, css: result.css, timeline: result.timeline, notes: result.notes, effects: Array.isArray(parsed?.effects) ? parsed.effects : [], authored: true, review: result._review || 'skipped' };
}

/**
 * Batch author with cache. Uncached briefs run with limited concurrency
 * (HF_AUTHOR_CONCURRENCY, default 3) — 18-scene builds finish in minutes,
 * not a serial half hour.
 */
async function authorCompositions(briefs, { projectDir, log, openMode = false } = {}) {
    const logFn = typeof log === 'function' ? log : (m) => console.log(m);
    const cache = projectDir ? loadCache(projectDir) : {};
    const out = new Array(briefs.length);
    const pending = [];
    // Style ledger (variety): a one-line fingerprint of every comp already
    // authored for this video — later briefs see it and avoid repeating the
    // same silhouette. Seeded from cache hits, grows as the batch lands.
    const ledger = [];
    const fingerprint = (brief, comp) => {
        // The measured half goes FIRST and in brackets, so a scanning author
        // sees three siblings opening at 0.60s before it reads three sentences
        // of prose about what they were going for.
        const motion = motionSignature(comp.timeline);
        const notes = String(comp.notes || '').replace(/\s+/g, ' ').slice(0, 110);
        return `${brief.kind}/${brief.type || 'comp'} ("${String(brief.text || '').slice(0, 30)}"): `
            + `${motion ? `[${motion}] ` : ''}${notes}`;
    };
    const safeCachedComposition = (brief, comp) => {
        if (!comp || comp.failed) return null;
        const validation = validateComposition(
            comp,
            brief.ns,
            brief.duration,
            brief.assets || [],
            brief
        );
        if (!validation.ok) return null;
        return {
            ...comp,
            html: validation.html,
            css: validation.css,
            timeline: normalizeAuthoredTimeline(validation.timeline, brief.duration),
        };
    };
    briefs.forEach((brief, i) => {
        const design = generateDesignDoc({ themeId: brief.themeId, styleProfile: brief.styleProfile, nicheId: brief.nicheId });
        const hash = briefHash(brief, design);
        if (cache[hash]) {
            const cachedComp = safeCachedComposition(brief, cache[hash]);
            if (cachedComp) {
                out[i] = { brief, composition: cachedComp, cached: true };
                cache[hash] = { ...cachedComp, ns: brief.ns };
                ledger.push(fingerprint(brief, cachedComp));
                return;
            }
            if (cache[hash].failed) {
                // A FAILURE IS NOT A VERDICT ON THE BRIEF — it is one bad
                // sample. The author is a language model at non-zero
                // temperature: the same brief that lost four rounds can be
                // authored cleanly on the next attempt, and the deterministic
                // repair pass in front of it keeps improving underneath a
                // marker that never expires. Honouring the marker on a build
                // meant a graphic that failed once fell back to the generic
                // hardcoded card in EVERY later build of that video — the user
                // rebuilds, sees the same ugly card, and nothing they or we fix
                // can dislodge it.
                //
                // So the marker now means exactly one thing: "do not spend AI
                // on this in open mode". A build always tries again.
                if (!openMode && !RETRY_FAILED_OFF) {
                    // Left in place rather than deleted: if this build crashes
                    // before the runner writes a new entry, the attempt history
                    // survives instead of resetting to zero.
                    pending.push({ brief, hash, i, attempts: Number(cache[hash].attempts) || 1 });
                    return;
                }
                if (RETRY_FAILED_OFF) {
                    out[i] = { brief, composition: null, cached: true };
                    return;
                }
                // Open mode falls THROUGH to the stale lookup below instead of
                // giving up here. A composition authored for this same slot
                // under an earlier version still beats the generic card, and
                // safeCachedComposition re-validates it against today's brief
                // before it is allowed anywhere near the render — so this
                // cannot resurrect something unsafe, and it costs no AI. The
                // marker itself is left alone — deleting it here would erase
                // the attempt history that the next build reports.
            } else {
                // A cache hit authored under an older/unsafe contract must not
                // be allowed back into the render path. Re-author during
                // builds; in open mode, try another valid stale entry for the
                // same namespace.
                delete cache[hash];
            }
        }
        if (openMode) {
            // OPEN MODE (project open / refresh): NEVER author — opening a
            // saved project must cost zero AI calls no matter what prompts/
            // themes/versions changed since the save. On a hash miss, reuse
            // the newest SAFE cached comp for the same content-stable ns; if
            // none exists, the fixed renderer covers it until the next BUILD.
            const stale = Object.values(cache)
                .filter(value => value && !value.failed && value.ns === brief.ns)
                .map(value => safeCachedComposition(brief, value))
                .filter(Boolean)
                .pop() || null;
            out[i] = { brief, composition: stale, cached: true, stale: Boolean(stale) };
            if (stale) ledger.push(fingerprint(brief, stale));
        } else {
            pending.push({ brief, hash, i });
        }
    });
    if (openMode) {
        const reusedStale = out.filter(o => o && o.stale).length;
        const missing = out.filter(o => o && !o.composition).length;
        logFn(`  ♻️ [Author] open mode: cache-only (${out.filter(o => o && o.composition).length} reused${reusedStale ? `, ${reusedStale} from previous version` : ''}${missing ? `, ${missing} on fixed renderer until next build` : ''}, 0 AI calls)`);
    }

    let aiCalls = 0;
    let done = 0;
    const concurrency = Math.max(1, Math.min(6, parseInt(process.env.HF_AUTHOR_CONCURRENCY || '3', 10) || 3));
    let cursor = 0;
    async function runner() {
        while (cursor < pending.length) {
            const job = pending[cursor++];
            const retry = Number(job.attempts) || 0;
            if (retry) logFn(`  🔁 [Author] retrying ${job.brief.ns} — it failed on ${retry} earlier build${retry === 1 ? '' : 's'}, and a failure is one bad sample, not a permanent verdict`);
            const comp = await authorComposition(job.brief, { log: logFn, ledger: ledger.slice() });
            aiCalls++;
            done++;
            // ns enables open-mode stale reuse; attempts is how many builds this
            // brief has now lost, so the log can name a chronically hard one.
            if (comp) {
                cache[job.hash] = comp.failed
                    ? { ...comp, ns: job.brief.ns, attempts: retry + 1 }
                    : { ...comp, ns: job.brief.ns };
            }
            const usable = comp && !comp.failed ? comp : null;
            if (usable) ledger.push(fingerprint(job.brief, usable));
            out[job.i] = { brief: job.brief, composition: usable, cached: false };
            logFn(`  🎨 [Author] ${done}/${pending.length} authored (${job.brief.ns}${usable ? (retry ? ' — RECOVERED' : '') : ' — FELL BACK'})`);
        }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, runner));
    try { await require('./hf-visual-lint').closeVisualLint(); } catch (_) { /* noop */ }

    if (projectDir) saveCache(projectDir, cache);
    const okCount = out.filter(o => o && o.composition).length;
    logFn(`  🎨 [Author] ${okCount}/${briefs.length} compositions authored (${aiCalls} AI calls, ${out.filter(o => o && o.cached).length} cached)`);
    // Art-director scorecard for the build log (fresh comps only — cached
    // comps were reviewed when first authored).
    const reviews = out.filter(o => o && o.composition && !o.cached).map(o => o.composition.review || 'skipped');
    if (reviews.length) {
        const n = (k) => reviews.filter(r => r === k).length;
        logFn(`  🎭 [Author] art director: ${n('approved')} approved, ${n('revised')} revised, ${n('kept-original')} kept original, ${n('skipped')} unreviewed`);
    }
    return out;
}

module.exports = {
    authorComposition,
    authorCompositions,
    authoredTransformConflicts,
    generateBriefHash: briefHash,
    inspectAuthoredTimeline,
    motionSignature,
    measureAuthoredMotion,
    normalizeAuthoredTimeline,
    // Exported so the verify gate can prove the rescue path end-to-end: that a
    // composition carrying a real rejection cause goes in and a composition the
    // full validator accepts comes out. A repair proved only against its own
    // rule is a repair proved against half the contract.
    rescueComposition,
    // Exported so the verify gate can prove a spoken narration number reaches
    // the allow-list — the guard that used to reject the facts it protects.
    spelledNumbersIn,
    validateComposition,
    MAX_AUTHOR_ROUNDS,
};
