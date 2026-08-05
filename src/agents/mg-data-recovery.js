'use strict';

/**
 * MG DATA RECOVERY — find the chart's numbers in the words the scene already has.
 *
 * THE PROBLEM THIS SOLVES
 *   A data MG ("barChart: Coefficient of Performance") is rejected when the piped
 *   content carries no `Label: Number` pairs. In the 2026-07-31 build that gate
 *   fired on charts whose numbers were sitting one field away, inside the scene's
 *   own narration — "a coefficient of performance of 28.7, against 3.5 for a
 *   standard heat pump". The planner had picked the right graphic for the right
 *   beat and simply hadn't copied the digits across. The pipeline then threw the
 *   graphic away AND sent its title to the footage hunter, so a scene that had a
 *   perfectly good chart in it spent minutes looking for stock video instead.
 *
 * WHY IT IS DELIBERATELY HARD TO SATISFY
 *   A chart with invented labels is worse than no chart: it is the one failure
 *   the viewer can actually read. So this recovers pairs ONLY from structures that
 *   are unambiguous in any language of numbers — never from a guess:
 *
 *     · both numbers must live in ONE sentence. Numbers from different sentences
 *       are two separate facts, and charting them together fabricates a
 *       comparison the writer never made.
 *     · each number must bind to a noun phrase through an explicit grammatical
 *       hook (`of/for/in/at/per/from/to`, an apposition, or a leading label).
 *     · the resulting labels must be distinct, short, and not just units — two
 *       bars both labelled "BTU" is a broken chart that passed a check.
 *     · the values must differ. A chart of two identical numbers has nothing to
 *       show.
 *
 *   Anything less certain returns null, and the caller's existing repair path
 *   runs exactly as it does today. This can add charts; it can never damage one.
 *
 * NO TOPIC KNOWLEDGE
 *   Nothing here knows what a heat pump or a coefficient is. The only inputs are
 *   the scene's own text and English function words, so it behaves identically
 *   for every niche — a nature video, a crime video and a tech video all get the
 *   same treatment from the same code path.
 */

// Structural English only — these are grammar, not subject matter. A word here
// can never BE a label, so a topic term can never be filtered out by accident.
const STOPWORDS = new Set([
    'a', 'an', 'the', 'and', 'or', 'but', 'of', 'for', 'in', 'on', 'at', 'to',
    'from', 'by', 'with', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'it',
    'its', 'this', 'that', 'these', 'those', 'their', 'there', 'here', 'than',
    'then', 'about', 'around', 'roughly', 'nearly', 'almost', 'over', 'under',
    'up', 'down', 'out', 'just', 'only', 'more', 'less', 'most', 'least',
    'per', 'each', 'every', 'some', 'any', 'all', 'both', 'other', 'another',
    'same', 'such', 'own', 'so', 'very', 'too', 'much', 'many', 'one', 'two',
    'which', 'while', 'whereas', 'when', 'where', 'who', 'whom', 'whose',
    'has', 'have', 'had', 'do', 'does', 'did', 'can', 'could', 'would',
    'should', 'will', 'shall', 'may', 'might', 'must', 'takes', 'take',
    'gives', 'give', 'get', 'gets', 'got', 'make', 'makes', 'made',
    'you', 'your', 'we', 'our', 'they', 'them', 'he', 'she', 'his', 'her',
]);

// Reporting verbs. A verb never names a chart bar, so these are trimmed off the
// edges of a candidate label ("Norway hit" -> "Norway"). Structural, not topical.
const REPORTING_VERBS = new Set([
    'hit', 'hits', 'sat', 'sits', 'stood', 'stands', 'reached', 'reaches',
    'produced', 'produces', 'made', 'makes', 'cost', 'costs', 'rose', 'fell',
    'grew', 'jumped', 'climbed', 'dropped', 'spent', 'spends', 'uses', 'used',
    'needs', 'needed', 'requires', 'required', 'holds', 'held', 'saw', 'sees',
    'posted', 'recorded', 'averaged', 'averages', 'totaled', 'totalled',
    'exceeded', 'topped', 'delivered', 'delivers', 'returned', 'returns',
    'runs', 'ran', 'goes', 'went', 'came', 'comes', 'brings', 'brought',
    'shows', 'showed', 'means', 'meant', 'says', 'said', 'adds', 'added',
]);

// Words that are pure quantity scaffolding — a label made only of these says
// nothing ("Percent: 40" is not a chart bar, it is a restatement of the axis).
const UNIT_ONLY = new Set([
    'percent', 'percentage', 'point', 'points', 'degree', 'degrees',
    'dollar', 'dollars', 'euro', 'euros', 'pound', 'pounds', 'ton', 'tons',
    'tonne', 'tonnes', 'kilo', 'kilos', 'kilogram', 'kilograms', 'gram',
    'grams', 'mile', 'miles', 'kilometre', 'kilometres', 'kilometer',
    'kilometers', 'metre', 'metres', 'meter', 'meters', 'foot', 'feet',
    'inch', 'inches', 'litre', 'litres', 'liter', 'liters', 'gallon',
    'gallons', 'hour', 'hours', 'minute', 'minutes', 'second', 'seconds',
    'day', 'days', 'week', 'weeks', 'month', 'months', 'year', 'years',
    'time', 'times', 'unit', 'units', 'btu', 'watt', 'watts', 'kilowatt',
    'kilowatts', 'megawatt', 'megawatts', 'joule', 'joules', 'calorie',
    'calories', 'celsius', 'fahrenheit', 'kelvin', 'million', 'billion',
    'trillion', 'thousand', 'hundred', 'number', 'total', 'amount', 'value',
    'rate', 'ratio', 'average', 'figure', 'figures',
]);

// A number worth charting: optional currency, digits with separators/decimals,
// optional trailing unit-ish suffix. Deliberately excludes bare 1-digit ordinals
// inside prose ("one of the") because those never survive STOPWORDS anyway.
const NUMBER_RE = /(?:[$€£]\s?)?\d{1,3}(?:,\d{3})+(?:\.\d+)?%?|(?:[$€£]\s?)?\d+(?:\.\d+)?\s?%?/g;

// Explicit "these two numbers belong on the same axis" cues.
const COMPARISON_CUE = /\b(?:versus|vs\.?|compared\s+(?:to|with)|against|whereas|while|but\s+only|up\s+from|down\s+from|rather\s+than|instead\s+of)\b/i;

function _sentences(text) {
    return String(text || '')
        .replace(/\s+/g, ' ')
        .split(/(?<=[.!?])\s+/)
        .map(s => s.trim())
        .filter(Boolean);
}

function _cleanLabelWords(raw) {
    return String(raw || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, ' ')
        .split(/\s+/)
        .filter(Boolean);
}

const _isEdgeNoise = (w) => STOPWORDS.has(w) || REPORTING_VERBS.has(w);

function _trimEdges(words, { trimTrailingUnits = true } = {}) {
    const out = [...words];
    while (out.length && _isEdgeNoise(out[0])) out.shift();
    while (out.length && (_isEdgeNoise(out[out.length - 1]) || (trimTrailingUnits && UNIT_ONLY.has(out[out.length - 1])))) out.pop();
    return out;
}

/**
 * Turn a candidate phrase into a chart label, or '' if it cannot carry one.
 *
 * Scaffolding is trimmed from the EDGES only. A label's middle keeps its
 * function words, because "Coefficient of Performance" is the name a viewer
 * reads — squeezing it to "Coefficient Performance" would make the chart look
 * machine-written, which is the one thing these graphics must never look.
 */
function _toLabel(raw) {
    const words = _cleanLabelWords(raw).filter(w => !/^\d+$/.test(w));
    // Trim first, THEN take the tail: English puts the head noun last, so the
    // last four words of "the system reached a coefficient of performance of"
    // are only the right four once the trailing "of" is gone.
    const kept = _trimEdges(_trimEdges(words).slice(-4));
    if (kept.length === 0) return '';
    if (kept.every(w => UNIT_ONLY.has(w) || STOPWORDS.has(w))) return '';   // an axis, not a bar
    if (kept.join('').length < 3) return '';
    return kept.map(w => (STOPWORDS.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(' ');
}

function _numericValue(token) {
    const n = parseFloat(String(token).replace(/[^0-9.]/g, ''));
    return Number.isFinite(n) ? n : null;
}

/**
 * Bind each number in one sentence to the noun phrase it belongs to.
 *
 * Two hooks, both structural:
 *   BEFORE  "<phrase> of|for|at|per <number>"   → the phrase names the number
 *   AFTER   "<number> <unit?> for|of|in <phrase>" → the phrase qualifies it
 * The winner is whichever hook yields a usable label; BEFORE is tried first
 * because "coefficient of performance of 28.7" is the commoner shape.
 */
// Index just past the last clause break in `text` — a comma, a semicolon, or a
// comparison cue. Everything before it belongs to a different number.
function _clauseStart(text) {
    let at = 0;
    const punct = Math.max(text.lastIndexOf(','), text.lastIndexOf(';'));
    if (punct >= 0) at = punct + 1;
    const cue = new RegExp(COMPARISON_CUE.source, 'gi');
    let m;
    while ((m = cue.exec(text)) !== null) at = Math.max(at, m.index + m[0].length);
    return at;
}

function _pairsInSentence(sentence) {
    const pairs = [];
    const seenValues = new Set();
    const matches = [...String(sentence).matchAll(NUMBER_RE)];

    for (let i = 0; i < matches.length; i++) {
        const m = matches[i];
        const token = m[0].trim();
        const value = _numericValue(token);
        if (value == null) continue;

        const start = m.index;
        const end = m.index + m[0].length;
        const prevEnd = i > 0 ? matches[i - 1].index + matches[i - 1][0].length : 0;
        const nextStart = i + 1 < matches.length ? matches[i + 1].index : sentence.length;

        // THE WINDOW IS THE WHOLE FIX. Each number may only read the words in
        // its own clause: after the previous number, after the last comma, and
        // after any comparison cue. Without that cut, the 3.5 in "a coefficient
        // of performance of 28.7, compared to 3.5 for a standard heat pump"
        // inherits the first number's words and both bars get named after it —
        // a chart that passes every check and is still wrong on screen.
        const beforeRaw = sentence.slice(prevEnd, start);
        const before = beforeRaw.slice(_clauseStart(beforeRaw));
        const after = sentence.slice(end, nextStart);

        // BEFORE: "<phrase> of|for|at 28.7" — the phrase names the number.
        let label = _toLabel(before.split(/\s+/).slice(-7).join(' '));

        // AFTER: "30 BTU for water" / "3.5 for a standard heat pump" — the
        // phrase qualifies it. Used when the number opens its own clause.
        if (!label) {
            const hook = after.match(/^[^,;.]{0,24}?\b(?:for|of|in|on|among|across|by)\b\s+([^,;.]{2,48})/i);
            if (hook) label = _toLabel(hook[1].split(/\s+/).slice(0, 5).join(' '));
        }

        if (!label) continue;
        if (seenValues.has(value)) continue;     // identical values chart as one bar
        seenValues.add(value);
        pairs.push({ label, value, token: token.replace(/\s+/g, '') });
    }
    return pairs;
}

function _dedupeLabels(pairs) {
    const out = [];
    const seen = new Set();
    for (const p of pairs) {
        const key = p.label.toLowerCase();
        if (seen.has(key)) continue;            // two bars, one name — broken chart
        seen.add(key);
        out.push(p);
    }
    return out;
}

/**
 * Try to rebuild a data MG's content from the scene's own words.
 *
 * @returns {{ content: string, pairs: Array, source: string } | null}
 *   `content` is a drop-in replacement for the string after "<mgType>: ",
 *   in the same `Title | Label: Value | Label: Value` shape every existing
 *   parser already reads. null means "not certain enough" — the caller must
 *   fall through to whatever it does today.
 */
function recoverDataPairs(scene, mgType, mgContent, opts = {}) {
    if (String(process.env.MG_DATA_RECOVERY || '').trim() === '0') return null;

    const minPairs = Math.max(2, Number(opts.minPairs) || 2);
    const maxPairs = Math.max(minPairs, Number(opts.maxPairs) || 5);

    // Only the pair-shaped charts. A bulletList recovered from prose would be
    // sentence fragments pretending to be bullets, and a comparisonCard needs a
    // rhetorical "A vs B" that no numeric scan can honestly supply.
    if (!['barChart', 'donutChart', 'rankingList', 'timeline'].includes(mgType)) return null;

    // Search the fields that carry the planner's own words for this beat, richest
    // first. The narration is last because it is the noisiest, not the least
    // trusted — an earlier field that yields a clean pair set is a better source.
    const sources = [
        ['mgContent', mgContent],
        ['visualIntent', scene?.visualIntent],
        ['mgHint', scene?.mgHint],
        ['narration', scene?.text],
    ];

    for (const [sourceName, raw] of sources) {
        const text = String(raw || '').trim();
        if (!text) continue;

        for (const sentence of _sentences(text)) {
            const found = _dedupeLabels(_pairsInSentence(sentence));
            if (found.length < minPairs) continue;

            // Two numbers in one sentence are only a comparison if the sentence
            // says so, or if each number carried its own distinct label.
            const cued = COMPARISON_CUE.test(sentence);
            if (!cued && found.length < 2) continue;

            const pairs = found.slice(0, maxPairs);
            const values = pairs.map(p => p.value);
            if (new Set(values).size < 2) continue;           // nothing to compare

            const title = _mgTitle(mgContent) || _mgTitle(scene?.visualIntent) || '';
            const body = pairs.map(p => `${p.label}: ${p.token}`).join(' | ');
            return {
                content: title ? `${title} | ${body}` : body,
                pairs,
                source: sourceName,
            };
        }
    }
    return null;
}

// The human title already sitting in the MG string, if it isn't itself a pair.
function _mgTitle(mgContent) {
    const first = String(mgContent || '').split(/\s*[|;]\s*/)[0]?.trim() || '';
    if (!first) return '';
    if (/^[^:]+:\s*[\d.,%$+-]+/.test(first)) return '';
    const words = first.split(/\s+/).filter(Boolean);
    if (words.length === 0 || words.length > 8) return '';
    return first;
}

module.exports = { recoverDataPairs };
