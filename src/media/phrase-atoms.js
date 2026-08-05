/**
 * phrase-atoms.js — "what counts as ONE thing in THIS video's language?"
 *
 * WHY THIS EXISTS
 *
 * Every search query in this app passes through a length budget. When the query
 * is over budget something has to go, and until now the cut was made per WORD.
 * A per-word cut does not know that some neighbouring words are a single name:
 *
 *     "thermometer inside dark earthen root cellar"  ->  "... earthen root"
 *     "measuring tape six feet deep hole"            ->  "measuring tape six feet"
 *     "stone spring house over flowing stream"       ->  "stone spring house over flowing"
 *
 * A "root" is not a shortened "root cellar" — it is a different noun. So the
 * shop is asked for the wrong object, and (worse) the mangled phrase is then
 * handed to the judge as the thing we wanted, so a perfect root-cellar clip is
 * rejected for not being a root.
 *
 * The same defect was already found and fixed once in the Visual Planner's
 * template-background builder, whose `compact()` helper is documented as
 * "never chop mid-phrase, which produces orphan fragments like 'Red Sea Suez
 * Canal' -> 'Red'". This module generalises that idea so every query builder
 * can share one answer.
 *
 * WHAT MAKES IT TOPIC-ADAPTIVE RATHER THAN A WORD LIST
 *
 * There is no list of compound nouns in here, and there never can be — the app
 * runs ~18 niches and every one of them has its own vocabulary. Instead an
 * "atom" is discovered from evidence that already exists in the run:
 *
 *   1. DECLARED. The Director/Planner already publishes `protectedTerms`,
 *      `entityContext` and `scriptContext.entities`. A multi-word entry there is
 *      a name by contract. (`buildYouTubeQuery` already treats these
 *      all-or-nothing; this extends the same courtesy to every other lane.)
 *
 *   2. REPEATED BY THE PLANNER. The planner authors `keyword`, `stockQuery`,
 *      `webQuery` and `visualIntent` as separate fields. When the same adjacent
 *      pair of words shows up in two of them independently, the planner is
 *      telling us it is one unit.
 *
 *   3. CAPITALISED RUNS. "Holmes County", "Red Sea". `_ytCoreQuery` already had
 *      this rule for YouTube only; it belongs to every lane.
 *
 *   4. LEARNED DURING THIS RUN. Every scene of a video is about the same topic,
 *      so a pair that recurs ACROSS scenes is this video's vocabulary. Scene 45
 *      gets to keep "root cellar" intact because scenes 33 and 36 already used
 *      it. A pair that actually won footage is promoted immediately.
 *
 * So an Amish-homestead video learns "root cellar", "spring house" and "barn
 * raising"; an oil-crisis video learns "oil tanker", "Strait of Hormuz" and
 * "shipping lane" — from the same code, with no niche branch anywhere.
 */

'use strict';

/** Never treat these as part of a name; they are grammar, not subject. */
const GLUE = new Set([
    'a', 'an', 'the', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'by', 'from',
    'and', 'or', 'into', 'onto', 'over', 'under', 'near', 'up', 'down', 'as',
    'is', 'are', 'was', 'were', 'that', 'this', 'it', 'be', 'been', 'being',
]);

/** Longest atom we will ever protect. Beyond this it stops being a name. */
const MAX_ATOM_WORDS = 4;

/** How many INDEPENDENT sources promote a pair to an atom. */
const PROMOTE_AT = 2;

/** Hard ceiling on the run memory so a long session cannot grow without bound. */
const MEMORY_CAP = 600;

// ---------------------------------------------------------------------------
// Run memory — what this video has taught us so far
//
// COUNTING RULE: sources, not sightings.
//
// The first draft counted every occurrence and immediately over-fired: the
// orchestrator derives `stockQuery` and `webQuery` FROM `searchKeyword`, so a
// scene's fields are often the same sentence three times. Counting occurrences
// made every adjacent pair in that sentence look "repeated", and the whole
// sentence chained into one giant atom. Derivation is not evidence.
//
// So a pair must show up in two INDEPENDENT places: two different scenes of the
// script, or a query field plus the narration a human actually wrote. Identical
// text contributes exactly once no matter how many fields carry it.
// ---------------------------------------------------------------------------

/** pair key -> Set of independent source ids that used it */
let _pairSources = new Map();
/** pair key -> the surface form to protect (first spelling wins) */
let _pairForm = new Map();
/** single word (lowercase) -> Set of independent source ids */
let _wordSources = new Map();
/** pair keys promoted by an actual footage win — never expire */
let _pairWon = new Set();
/** monotonic id for anonymous text with no scene of its own */
let _anonSeq = 0;
/** normalized text -> the source id already assigned to it */
let _textSource = new Map();

function resetPhraseMemory() {
    _pairSources = new Map();
    _pairForm = new Map();
    _wordSources = new Map();
    _pairWon = new Set();
    _textSource = new Map();
    _anonSeq = 0;
}

function phraseMemoryStats() {
    let learned = 0;
    for (const [key, sources] of _pairSources) {
        if (sources.size >= PROMOTE_AT || _pairWon.has(key)) learned++;
    }
    return {
        pairs: _pairSources.size,
        words: _wordSources.size,
        won: _pairWon.size,
        learned,
    };
}

function _trimMemory() {
    if (_pairSources.size <= MEMORY_CAP) return;
    // Drop the weakest single-source pairs first; a pair that won footage or
    // that two independent sources agree on is exactly what we are here to keep.
    for (const [key, sources] of _pairSources) {
        if (_pairSources.size <= MEMORY_CAP) break;
        if (sources.size >= PROMOTE_AT || _pairWon.has(key)) continue;
        _pairSources.delete(key);
        _pairForm.delete(key);
    }
}

// ---------------------------------------------------------------------------
// Tokenising
// ---------------------------------------------------------------------------

function _clean(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function _words(value) {
    return _clean(value).split(/\s+/).filter(Boolean);
}

/** Comparison form of one word: letters/digits/hyphen only, lowercased. */
function _key(word) {
    return String(word || '').toLowerCase().replace(/[^\p{L}\p{N}-]/gu, '');
}

function _isGlue(word) {
    return GLUE.has(_key(word));
}

function _isCapitalized(word) {
    return /^[A-Z]/.test(String(word || ''));
}

function _pairKey(a, b) {
    return `${_key(a)} ${_key(b)}`;
}

/** Every adjacent, glue-free word pair in a string. */
function _adjacentPairs(text) {
    const w = _words(text);
    const out = [];
    for (let i = 0; i + 1 < w.length; i++) {
        const a = w[i];
        const b = w[i + 1];
        if (_isGlue(a) || _isGlue(b)) continue;
        const ka = _key(a);
        const kb = _key(b);
        if (!ka || !kb) continue;
        // A bare number is not half of a name ("six feet" is, "6" alone is not).
        if (/^\d+$/.test(ka) && /^\d+$/.test(kb)) continue;
        out.push({ key: `${ka} ${kb}`, form: `${a} ${b}` });
    }
    return out;
}

// ---------------------------------------------------------------------------
// Feeding the memory
// ---------------------------------------------------------------------------

function _addSource(map, key, sourceId) {
    let set = map.get(key);
    if (!set) { set = new Set(); map.set(key, set); }
    set.add(sourceId);
}

/**
 * A stable id for one piece of evidence. Two callers passing the same sentence
 * get the same id, so a query copied into three fields still counts once.
 */
function _sourceIdFor(value, explicit) {
    if (explicit !== undefined && explicit !== null && explicit !== '') return `s:${explicit}`;
    const norm = value.toLowerCase();
    let id = _textSource.get(norm);
    if (!id) {
        id = `t:${++_anonSeq}`;
        _textSource.set(norm, id);
        if (_textSource.size > MEMORY_CAP * 4) _textSource.clear();
    }
    return id;
}

/**
 * Record the language of one piece of text.
 *
 * @param {string} text
 * @param {string|number} [sourceId] which independent source this came from.
 *        Pass the scene index for scene-authored text. Omit it and identical
 *        text is de-duplicated automatically.
 */
function observeText(text, sourceId) {
    const value = _clean(text);
    if (!value) return;
    const id = _sourceIdFor(value, sourceId);
    for (const word of _words(value)) {
        const k = _key(word);
        if (!k || _isGlue(word)) continue;
        _addSource(_wordSources, k, id);
    }
    for (const pair of _adjacentPairs(value)) {
        _addSource(_pairSources, pair.key, id);
        if (!_pairForm.has(pair.key)) _pairForm.set(pair.key, pair.form);
    }
    _trimMemory();
}

/** Every downloader-facing field a scene may carry, in authoring order. */
function _sceneQueryFields(scene) {
    if (!scene) return [];
    const isGraphic = !!(scene.mgHint || scene.fullscreenMG || scene.templateHint);
    return [
        scene.searchKeyword,
        scene.researchKeyword,
        scene.keyword,
        scene.stockQuery,
        scene.webQuery,
        // On a graphic scene `visualIntent` describes the MOTION GRAPHIC, not a
        // shot, so it is not evidence about footage vocabulary. Same exclusion
        // `buildSearchKeywordVariants` already makes, for the same reason.
        isGraphic ? null : scene.visualIntent,
    ].filter(Boolean).map(_clean).filter(Boolean);
}

/**
 * Feed one scene's authored language into the run memory.
 *
 * All of a scene's query fields share ONE source id, because the orchestrator
 * derives most of them from `searchKeyword` — three copies of a sentence is one
 * opinion, not three. The narration is the exception: a human wrote it before
 * any query existed, so a pair that appears in BOTH the queries and the
 * narration has two genuinely independent witnesses and is promoted on the
 * strength of one scene.
 *
 * Narration is only ever checked against pairs the queries already produced, so
 * long prose cannot flood the memory with junk.
 */
function observeScene(scene, sourceId) {
    if (!scene) return;
    const id = sourceId !== undefined ? sourceId
        : (scene.index !== undefined && scene.index !== null ? scene.index : undefined);
    const fields = _sceneQueryFields(scene);
    if (fields.length === 0) return;

    const fromQueries = new Set();
    for (const field of fields) {
        observeText(field, id);
        for (const pair of _adjacentPairs(field)) fromQueries.add(pair.key);
    }

    const narration = _clean(scene.text);
    if (!narration || fromQueries.size === 0) return;
    const narrationId = id !== undefined ? `n:${id}` : _sourceIdFor(narration);
    for (const pair of _adjacentPairs(narration)) {
        if (!fromQueries.has(pair.key)) continue;   // corroboration only, never seeding
        _addSource(_pairSources, pair.key, narrationId);
        _addSource(_wordSources, pair.key.split(' ')[0], narrationId);
        _addSource(_wordSources, pair.key.split(' ')[1], narrationId);
    }
    _trimMemory();
}

/** Feed a whole script at once, so scene 1 already knows the video's vocabulary. */
function observeScenes(scenes) {
    let n = 0;
    for (const scene of (Array.isArray(scenes) ? scenes : [])) {
        if (!scene) continue;
        observeScene(scene, scene.index !== undefined && scene.index !== null ? scene.index : `i${n}`);
        n++;
    }
    return phraseMemoryStats();
}

/**
 * A query just produced usable footage. Promote its pairs immediately — a pair
 * that a real provider answered is proven vocabulary, worth more than any
 * amount of corroboration.
 */
function rememberPhraseWin(query) {
    const value = _clean(query);
    if (!value) return;
    for (const pair of _adjacentPairs(value)) {
        _pairWon.add(pair.key);
        if (!_pairForm.has(pair.key)) _pairForm.set(pair.key, pair.form);
        _addSource(_pairSources, pair.key, 'win');
    }
    _trimMemory();
}

/**
 * How many independent sources in this run used the word? Used to decide whether
 * a word on the generic "noise" list is actually the subject of THIS video
 * ("trade", "barrel", "policy" in an oil-crisis script).
 */
function wordWeight(word) {
    const set = _wordSources.get(_key(word));
    return set ? set.size : 0;
}

// ---------------------------------------------------------------------------
// Discovering atoms
// ---------------------------------------------------------------------------

function _pushAtom(out, seen, phrase) {
    const w = _words(phrase).slice(0, MAX_ATOM_WORDS);
    if (w.length < 2) return;
    if (w.every(_isGlue)) return;
    const key = w.map(_key).join(' ');
    if (!key.trim() || seen.has(key)) return;
    seen.add(key);
    out.push({ key, words: w });
}

/** Consecutive capitalised words — "Holmes County", "Red Sea". */
function _capitalizedRuns(text, out, seen) {
    const w = _words(text);
    let run = [];
    for (const word of w) {
        if (_isCapitalized(word) && _key(word)) {
            run.push(word);
            continue;
        }
        // A glue word INSIDE a run keeps it alive ("Gulf of Aden") but is not
        // allowed to start or end it.
        if (run.length > 0 && _isGlue(word)) {
            run.push(word);
            continue;
        }
        if (run.length >= 2) _pushAtom(out, seen, run.join(' '));
        run = [];
    }
    if (run.length >= 2) _pushAtom(out, seen, run.join(' '));
}

/**
 * Chain overlapping promoted pairs into the longest name they describe:
 * "spring house" + "house over"  ->  no (the second is not promoted)
 * "root cellar" + "cellar entrance" (both promoted) -> "root cellar entrance"
 */
function _chainedPairs(text, out, seen) {
    const w = _words(text);
    let i = 0;
    while (i + 1 < w.length) {
        const first = _pairKey(w[i], w[i + 1]);
        if (!_isPromoted(first)) { i++; continue; }
        const run = [w[i], w[i + 1]];
        let j = i + 1;
        while (j + 1 < w.length && run.length < MAX_ATOM_WORDS) {
            if (!_isPromoted(_pairKey(w[j], w[j + 1]))) break;
            run.push(w[j + 1]);
            j++;
        }
        _pushAtom(out, seen, run.join(' '));
        i = j;
    }
}

function _isPromoted(pairKey) {
    if (_pairWon.has(pairKey)) return true;
    const sources = _pairSources.get(pairKey);
    return !!sources && sources.size >= PROMOTE_AT;
}

/**
 * The atoms that apply to one scene's queries.
 *
 * @param {object} scene
 * @param {object} [scriptContext]
 * @param {object} [opts]
 * @param {string} [opts.text] extra text to consider (the query being trimmed,
 *        when it did not come from the scene itself — a retry variant, say).
 * @param {boolean} [opts.observe=true] also feed this scene into the run memory.
 * @returns {Array<{key:string, words:string[]}>} longest first
 */
function collectAtoms(scene, scriptContext = {}, opts = {}) {
    const out = [];
    const seen = new Set();

    // The query being trimmed belongs to THIS scene — observe it under the
    // scene's own id, never anonymously, or a scene would corroborate itself.
    const selfId = scene && scene.index !== undefined && scene.index !== null
        ? scene.index : undefined;
    if (opts.observe !== false) observeScene(scene, selfId);
    if (opts.text) observeText(opts.text, selfId !== undefined ? selfId : 'self');

    // 1. Declared entities — names by contract.
    const declared = [
        ...(Array.isArray(scene?.protectedTerms) ? scene.protectedTerms : []),
        ...(Array.isArray(scene?.entityContext) ? scene.entityContext : []),
        ...(Array.isArray(scriptContext?.entities) ? scriptContext.entities : []),
        scriptContext?.eventAnchor,
    ].filter(Boolean);
    for (const term of declared) _pushAtom(out, seen, term);

    // 2/3/4. Evidence found inside the scene's own language.
    const surfaces = _sceneQueryFields(scene);
    if (opts.text) surfaces.unshift(_clean(opts.text));
    for (const surface of surfaces) {
        _capitalizedRuns(surface, out, seen);
        _chainedPairs(surface, out, seen);
    }

    // Longest first so greedy matching prefers "root cellar entrance" over
    // "root cellar".
    out.sort((a, b) => b.words.length - a.words.length);
    return out;
}

// ---------------------------------------------------------------------------
// Using atoms
// ---------------------------------------------------------------------------

/**
 * Break text into UNITS. An atom occurrence is one unit; every other word is a
 * unit of one. Nothing downstream may split a unit.
 *
 * @returns {Array<{words:string[], index:number, isAtom:boolean}>}
 */
function splitUnits(text, atoms = []) {
    const w = _words(text);
    const units = [];
    const list = (atoms || []).slice().sort((a, b) => b.words.length - a.words.length);
    let i = 0;
    while (i < w.length) {
        let matched = null;
        for (const atom of list) {
            const n = atom.words.length;
            if (n < 2 || i + n > w.length) continue;
            let ok = true;
            for (let k = 0; k < n; k++) {
                if (_key(w[i + k]) !== _key(atom.words[k])) { ok = false; break; }
            }
            if (ok) { matched = w.slice(i, i + n); break; }
        }
        if (matched) {
            units.push({ words: matched, index: i, isAtom: true });
            i += matched.length;
        } else {
            units.push({ words: [w[i]], index: i, isAtom: false });
            i += 1;
        }
    }
    return units;
}

/**
 * Fill a word budget with whole units, in the order given.
 *
 * A unit that does not fit is SKIPPED, not truncated — that is the entire
 * point. Later, smaller units can still fit, so "root cellar entrance Holmes
 * County farm" at a budget of 5 keeps "root cellar entrance" + "farm" rather
 * than shearing "Holmes" off its county.
 *
 * Atoms are reserved FIRST, then the loose words fill what is left. Otherwise a
 * tight budget spends itself on the first few adjectives and drops the one
 * phrase the scene is actually about ("stone staircase descending" survives,
 * "root cellar" gets cut). Source order is always restored at the end, so the
 * query still reads the way the planner wrote it.
 *
 * The one exception: if the very first unit is itself over budget, it is kept
 * whole (up to a small stretch). Half a name is worse than a long query.
 */
function packUnits(units, maxWords) {
    const budget = Math.max(1, Number(maxWords) || 1);
    const stretch = budget + 2;
    const list = Array.isArray(units) ? units : [];

    const picked = new Set();
    let used = 0;

    // Pass 1 — atoms, in source order. These are the named things.
    for (const unit of list) {
        if (!unit.isAtom) continue;
        const n = unit.words.length;
        if (used + n > budget) continue;
        picked.add(unit);
        used += n;
    }

    // Pass 2 — everything else, in source order, into whatever room is left.
    for (const unit of list) {
        if (picked.has(unit)) continue;
        const n = unit.words.length;
        if (used + n <= budget) {
            picked.add(unit);
            used += n;
        }
    }

    // Nothing fit at all: keep the first unit whole rather than return nothing.
    if (picked.size === 0 && list.length > 0 && list[0].words.length <= stretch) {
        picked.add(list[0]);
    }

    return list.filter(u => picked.has(u));
}

/**
 * Cut `text` down to `maxWords` without ever splitting an atom. Source order is
 * preserved.
 */
function trimToBudget(text, maxWords, atoms = []) {
    const units = splitUnits(text, atoms);
    const picked = packUnits(units, maxWords);
    return picked.flatMap(u => u.words).join(' ');
}

/** True when `word` at position `index` is inside one of the atoms of `text`. */
function isInsideAtom(text, index, atoms = []) {
    let cursor = 0;
    for (const unit of splitUnits(text, atoms)) {
        const end = cursor + unit.words.length;
        if (index >= cursor && index < end) return unit.isAtom;
        cursor = end;
    }
    return false;
}

module.exports = {
    collectAtoms,
    splitUnits,
    packUnits,
    trimToBudget,
    isInsideAtom,
    observeText,
    observeScene,
    observeScenes,
    rememberPhraseWin,
    wordWeight,
    resetPhraseMemory,
    phraseMemoryStats,
    MAX_ATOM_WORDS,
    PROMOTE_AT,
};
