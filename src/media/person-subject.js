'use strict';

/**
 * PERSON SUBJECT — "is this scene about the video's main character?"
 *
 * A faceless channel built around ONE real person (an athlete, a founder, a
 * defendant) cannot be judged with the same footage bar as a topic video.
 *
 * Aug-15 build, "Victoria Mboko beats Naomi Osaka": free stock libraries hold no
 * Mboko footage at all, so the judge looked at generic tennis clips and scored
 * them 1-3/10 — "empty court, no visible player match" — which is a CORRECT
 * reading of the frame and the wrong verdict for the video. Every candidate fell
 * under the accept floor of 6, the scene churned into Media Repair, and the
 * build shipped weak filler anyway. We went looking for a person free stock does
 * not have, then punished every clip for not being her.
 *
 * Channels that actually make these videos do not cut the exact moment. They cut
 * ANY real footage of the person playing, celebrating, walking on court or being
 * interviewed, photos on a slow pan, the crowd, the flags, the arena, the
 * trophy — and let the narration carry the specific beat. Exact-moment accuracy
 * is a bonus that wins ties, not an entry requirement.
 *
 * ── Why this is topic-adaptive and not a niche rule ──────────────────────────
 * There is no niche list here and no `if (niche === 'sport')`. The question is
 * answered per scene from data the pipeline already produced: the Director's
 * typed entity list (`scriptContext.entityTypes`, which already tags `person`
 * and already drives the web-image force in the Visual Planner), and whether the
 * video's own title/summary is ABOUT that person. A tennis video about Mboko
 * gets the relief on her scenes; a history video about aqueducts has no
 * person-typed entity in its title, so nothing moves. Same code, opposite
 * answer, decided by the script.
 *
 * ── Why it fails closed ──────────────────────────────────────────────────────
 * A main character must be `person`-typed by the Director AND named in the
 * video's title/summary/anchor. An untyped entity never qualifies, so a topic,
 * graphic or history video can never drift into the relaxed bar by accident —
 * which is the whole point: accuracy still matters everywhere else.
 *
 * ── What this deliberately does NOT do ───────────────────────────────────────
 * It does not touch the hard rejects. Anchors, presenter faces, picture-in-
 * picture commentary, channel logos and news tickers stay rejected for a
 * person-subject scene exactly as they are everywhere else. The only thing that
 * changes is that "this is the right person doing the right activity, on the
 * wrong day" stops being a failure.
 */

/** Person-typed entities only. The Director's own tag, not a guess. */
const PERSON_TYPE = 'person';

/**
 * Tokens that can never stand in for a surname. A one-word reference like
 * "Williams" is how scripts actually name people, but only when the token is
 * distinctive enough to be that person and not an ordinary word.
 */
const WEAK_SURNAMES = new Set([
    'the', 'and', 'king', 'queen', 'prince', 'pope', 'lord', 'lady', 'city',
    'team', 'club', 'united', 'state', 'states', 'company', 'group', 'party',
    'army', 'navy', 'force', 'forces', 'court', 'house', 'park', 'river',
    'young', 'senior', 'junior', 'east', 'west', 'north', 'south', 'star',
]);

const MIN_SURNAME_LENGTH = 4;

function _str(v) {
    return typeof v === 'string' ? v : (v == null ? '' : String(v));
}

function _clean(v) {
    return _str(v).replace(/\s+/g, ' ').trim();
}

function _escapeRe(v) {
    return _str(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function _collect(list, out) {
    if (!Array.isArray(list)) return;
    for (const item of list) {
        const s = _clean(item);
        if (s) out.push(s);
    }
}

/**
 * Is `name` referred to anywhere in `text`? Whole-word, case-insensitive.
 * Scripts say "Mboko dominated the second set" far more often than they repeat
 * the full name, so a distinctive surname counts as a reference.
 */
function _mentions(text, aliases) {
    const haystack = _clean(text);
    if (!haystack) return '';
    for (const alias of aliases) {
        if (!alias) continue;
        const re = new RegExp(`(?:^|[^\\p{L}\\p{N}])${_escapeRe(alias)}(?:[^\\p{L}\\p{N}]|$)`, 'iu');
        if (re.test(haystack)) return alias;
    }
    return '';
}

/**
 * Full name plus the surname when it is distinctive enough to stand alone.
 */
function aliasesFor(name) {
    const full = _clean(name);
    if (!full) return [];
    const out = [full];
    const tokens = full.split(/\s+/).filter(Boolean);
    if (tokens.length >= 2) {
        const surname = tokens[tokens.length - 1].replace(/[^\p{L}\p{N}'-]/gu, '');
        if (surname.length >= MIN_SURNAME_LENGTH && !WEAK_SURNAMES.has(surname.toLowerCase())) {
            out.push(surname);
        }
    }
    return out;
}

function _personEntities(scriptContext) {
    const entities = Array.isArray(scriptContext?.entities) ? scriptContext.entities : [];
    const types = scriptContext?.entityTypes || {};
    const out = [];
    const seen = new Set();
    for (const raw of entities) {
        const name = _clean(raw);
        if (!name) continue;
        const key = name.toLowerCase();
        if (seen.has(key)) continue;
        if (_str(types[key]).toLowerCase() !== PERSON_TYPE) continue;
        seen.add(key);
        out.push(name);
    }
    return out;
}

/**
 * The video's identity statement: what this video says it is about, at the
 * video level rather than the scene level. `videoTitle` + `summary` is the same
 * pair `footage-manager._videoTopic()` already hands the vision judge.
 */
function _videoIdentityText(scriptContext) {
    return [
        scriptContext?.videoTitle,
        scriptContext?.title,
        scriptContext?.summary,
        scriptContext?.eventAnchor,
    ].map(_clean).filter(Boolean).join(' — ');
}

// Memoized per scriptContext object: the hunter profile is rebuilt for every
// scene and every retry, and the answer cannot change within a build.
const _mainCharacterCache = new WeakMap();

/**
 * The person-typed entities this video is actually ABOUT.
 *
 * @returns {Array<{name: string, aliases: string[]}>}
 */
function resolveMainCharacters(scriptContext) {
    if (!scriptContext || typeof scriptContext !== 'object') return [];
    const cached = _mainCharacterCache.get(scriptContext);
    if (cached) return cached;

    const identity = _videoIdentityText(scriptContext);
    const out = [];
    if (identity) {
        for (const name of _personEntities(scriptContext)) {
            const aliases = aliasesFor(name);
            if (_mentions(identity, aliases)) out.push({ name, aliases });
        }
    }

    _mainCharacterCache.set(scriptContext, out);
    return out;
}

/** Is the relaxed person-subject bar switched on? Default ON. */
function isRelaxedEnabled() {
    const raw = _str(process.env.FOOTAGE_PERSON_SUBJECT_RELAXED).trim().toLowerCase();
    if (!raw) return true;
    return !['0', 'off', 'false', 'no'].includes(raw);
}

/**
 * The accept floor for a person-subject scene. Clamped below the strict floor
 * so this can only ever loosen, never tighten.
 */
function personSubjectMinScore(strictMinScore) {
    const parsed = parseInt(_str(process.env.FOOTAGE_PERSON_SUBJECT_MIN_SCORE) || '4', 10);
    const wanted = Math.max(1, Math.min(9, Number.isFinite(parsed) ? parsed : 4));
    const strict = Number(strictMinScore);
    return Number.isFinite(strict) ? Math.min(strict, wanted) : wanted;
}

/**
 * Is THIS scene about a main character?
 *
 * Unlike `detectRequestedPackaging`, the narration IS read here. That module
 * asks "what should we fetch", where narration describes the overlay we will
 * draw. This module asks "who is this scene about", which is precisely a
 * narration question.
 *
 * @returns {{active: boolean, people: string[], aliases: string[], evidence: string, mainCharacters: string[]}}
 */
function detectPersonSubject(input = {}) {
    const scene = input.scene || null;
    const scriptContext = input.scriptContext || {};
    const agentPlan = input.agentPlan || scene?._mediaAgentPlan || null;

    const mainCharacters = resolveMainCharacters(scriptContext);
    const inactive = {
        active: false,
        people: [],
        aliases: [],
        evidence: '',
        mainCharacters: mainCharacters.map(p => p.name),
    };
    // One gate for the whole feature: with the flag off, `active` never turns on,
    // so the rule is never injected and every threshold stays strict.
    if (!isRelaxedEnabled()) return inactive;
    if (!mainCharacters.length) return inactive;
    // A map/template/graphic lane never downloads person footage, so relaxing
    // its bar would only admit noise.
    if (input.allowGraphics) return inactive;

    const sources = [];
    _collect([
        input.keyword,
        scene?._forcedSearchKeyword,
        scene?.searchKeyword,
        scene?.researchKeyword,
        scene?.keyword,
        scene?.stockQuery,
        scene?.webQuery,
        scene?.visualIntent,
        scene?.visualDescription,
        scene?.text,
    ], sources);
    _collect(scene?.protectedTerms, sources);
    _collect(scene?.entityContext, sources);
    _collect(agentPlan?.mandatoryIdentity, sources);
    _collect(agentPlan?.mandatoryVisible, sources);
    _collect(agentPlan?.mustShow, sources);
    _collect(agentPlan?.subjectAnchors, sources);

    const sceneText = sources.join(' • ');
    const people = [];
    const aliases = [];
    let evidence = '';
    for (const person of mainCharacters) {
        const hit = _mentions(sceneText, person.aliases);
        if (!hit) continue;
        people.push(person.name);
        aliases.push(...person.aliases);
        if (!evidence) evidence = hit;
    }

    if (!people.length) return inactive;
    return {
        active: true,
        people,
        aliases: [...new Set(aliases)],
        evidence,
        mainCharacters: mainCharacters.map(p => p.name),
    };
}

/**
 * Are the scene's mandatory-visible entities nothing but the main character?
 *
 * The Media Agent marks a named person `frame-visible`, and the deterministic
 * mismatch gate then caps any clip that cannot prove that face at 4. On a
 * person-subject scene that cap is the exact failure this module exists to fix:
 * free stock has no footage of her, so every candidate is capped under the
 * accept floor and the scene ends up empty.
 *
 * Returns true ONLY when every mandatory entity is the main character. A scene
 * that also demands a product, logo or place keeps the strict cap — that
 * requirement has nothing to do with who the video is about.
 */
function personSubjectCoversMandatory(personSubject, mandatoryEntities) {
    if (!personSubject?.active || !personSubject.aliases?.length) return false;
    const list = (Array.isArray(mandatoryEntities) ? mandatoryEntities : [])
        .map(_clean)
        .filter(Boolean);
    if (!list.length) return false;
    return list.every(term => !!_mentions(term, personSubject.aliases));
}

/**
 * The instruction injected into the vision judge for a person-subject scene.
 *
 * Same slot and same shape as REQUESTED_GRAPHIC_RULE in clip-analyzer.js: it
 * names what stops counting as a defect without un-naming the broadcast
 * packaging that is still never wanted.
 */
function renderPersonSubjectRule(personSubject) {
    if (!personSubject?.active || !personSubject.people?.length) return '';
    const who = personSubject.people.slice(0, 3).join(' / ');
    return `- PERSON-SUBJECT SCENE: this scene is about ${who}, a main character of this video. Score ANY footage that plausibly shows ${who} — or the sport/event/arena/work they are known for — as GOOD B-roll (7-9), even when it is NOT the exact moment, match, day or scoreline the narration describes. Reward: the subject competing/playing/working, celebrating, warming up, walking on, being interviewed or photographed; a real photo of them; the crowd; national flags; the stadium/venue; the trophy; a scoreboard. Exact-moment accuracy is a BONUS, not a requirement — if a clip DOES show the exact moment described, score it 9-10 so it outranks generic on-subject footage, but never reject a clip merely for being a different day. Anonymous footage of the same activity with no sign of ${who} is acceptable last-resort filler — score it 5-6, not 1-3. Score 3 or lower ONLY for clearly off-subject footage: a different sport or activity, an unrelated setting (beach, skyline), an unrelated person as the clear subject, presenters/anchors/commentators, picture-in-picture faces, channel logos, news tickers, or thumbnails.`;
}

module.exports = {
    mentionsAny: _mentions,
    resolveMainCharacters,
    detectPersonSubject,
    renderPersonSubjectRule,
    personSubjectCoversMandatory,
    personSubjectMinScore,
    isRelaxedEnabled,
    aliasesFor,
    PERSON_TYPE,
};
