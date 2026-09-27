#!/usr/bin/env node
'use strict';

/**
 * GATE: a scene about the video's main character is judged as "is this the
 * right person doing the right thing", but ONLY that scene.
 *
 * Aug-15 build, "Victoria Mboko Beats Naomi Osaka": free stock libraries hold
 * no Mboko footage, so the judge scored generic tennis clips 1-3/10 ("empty
 * court, no visible player match") — a correct reading of the frame and the
 * wrong verdict for the video. Every candidate fell under the accept floor of
 * 6, the scenes churned into Media Repair, and the build shipped weak filler.
 *
 * Both directions are pinned here, because each one alone is satisfiable by a
 * broken implementation:
 *
 *   1. RELAXED where it should be. A person-subject scene accepts on-subject
 *      footage of the main character from a different day/match.
 *   2. STRICT everywhere else. A history/science topic scene keeps the old
 *      floor and still rejects off-topic footage. A gate that only checked (1)
 *      would be satisfied by lowering the bar globally — which is precisely the
 *      accuracy regression this must not cause.
 *
 * And two containment checks, because "accept more" must not mean "accept
 * anything": genuinely off-subject footage still fails on a person-subject
 * scene, and the broadcast-packaging hard rejects (anchors, tickers, PiP faces)
 * still fire at any score.
 *
 * Kill switch: FOOTAGE_PERSON_SUBJECT_RELAXED=off (the feature's own flag).
 */

const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

const {
    detectPersonSubject,
    renderPersonSubjectRule,
    personSubjectMinScore,
    personSubjectCoversMandatory,
    resolveMainCharacters,
} = require(path.join(ROOT, 'src', 'media', 'person-subject'));
const { buildMediaHunterProfile } = require(path.join(ROOT, 'src', 'media', 'media-hunter'));
const { _parseWindowValidation } = require(path.join(ROOT, 'src', 'media', 'clip-analyzer'));

const failures = [];
let checks = 0;

function check(ok, message) {
    checks++;
    if (!ok) failures.push(message);
    return ok;
}

// ── Fixtures ────────────────────────────────────────────────────────────────
// A person-driven channel: the Director typed Mboko/Osaka as `person`, and the
// video's own title is about them.
const PERSON_CONTEXT = {
    videoTitle: 'Victoria Mboko Beats Naomi Osaka',
    summary: 'Teenager Victoria Mboko stuns Naomi Osaka to win the National Bank Open.',
    entities: ['Victoria Mboko', 'Naomi Osaka', 'National Bank Open'],
    entityTypes: {
        'victoria mboko': 'person',
        'naomi osaka': 'person',
        'national bank open': 'event',
    },
    nicheId: 'explainer.sport',
};

// A topic-driven channel: no person is the protagonist. Caesar is `person`-typed
// but the video is not about him, so he must NOT become a main character.
const TOPIC_CONTEXT = {
    videoTitle: 'How Roman Aqueducts Actually Worked',
    summary: 'The engineering behind the aqueduct system that supplied ancient Rome.',
    entities: ['Roman Empire', 'Julius Caesar', 'Pont du Gard'],
    entityTypes: {
        'roman empire': 'org',
        'julius caesar': 'person',
        'pont du gard': 'place',
    },
    nicheId: 'explainer.history',
};

const personScene = {
    text: 'Mboko broke serve in the second set and never looked back.',
    keyword: 'Victoria Mboko tennis',
    searchKeyword: 'Victoria Mboko tennis',
    protectedTerms: ['Victoria Mboko'],
    mediaType: 'video',
    mediaIntent: { lane: 'realVideo', policy: { download: 'download' } },
};

const topicScene = {
    text: 'Gravity alone carried the water across sixteen kilometres of stone.',
    keyword: 'roman aqueduct stone channel',
    searchKeyword: 'roman aqueduct stone channel',
    protectedTerms: ['Pont du Gard'],
    mediaType: 'video',
    mediaIntent: { lane: 'realVideo', policy: { download: 'download' } },
};

const personProfile = buildMediaHunterProfile(personScene, PERSON_CONTEXT, {
    keyword: personScene.keyword,
    mediaType: 'video',
    nicheId: PERSON_CONTEXT.nicheId,
});
const topicProfile = buildMediaHunterProfile(topicScene, TOPIC_CONTEXT, {
    keyword: topicScene.keyword,
    mediaType: 'video',
    nicheId: TOPIC_CONTEXT.nicheId,
});

// ── 1. Detection ────────────────────────────────────────────────────────────
check(personProfile.personSubject?.active === true,
    'a scene about the video main character must be detected as person-subject');
check(personProfile.personSubject?.people?.includes('Victoria Mboko'),
    'the detected main character must be Victoria Mboko');
check(topicProfile.personSubject?.active === false,
    'a history topic scene must NOT be treated as person-subject');
check(resolveMainCharacters(TOPIC_CONTEXT).length === 0,
    'a person-typed entity the video is not about must not become a main character');

// The surname alone is how scripts actually refer to people.
check(detectPersonSubject({
    scene: { text: 'Mboko celebrated on court.', keyword: 'tennis celebration' },
    scriptContext: PERSON_CONTEXT,
}).active === true, 'a surname-only reference must still resolve to the main character');

// ── 2. Thresholds ───────────────────────────────────────────────────────────
const STRICT_FLOOR = 6;
const relaxedFloor = personSubjectMinScore(STRICT_FLOOR);
check(relaxedFloor === 4, `person-subject accept floor must be 4 (got ${relaxedFloor})`);
check(personSubjectMinScore(STRICT_FLOOR) < STRICT_FLOOR,
    'the person-subject floor must be strictly lower than the strict floor');

// ── 3. The SAME clip, judged against both scenes ────────────────────────────
// One raw model verdict, replayed through the real parser + gate twice.
const GENERIC_TENNIS_VERDICT = [
    'WINDOW: PASS',
    'ISSUES: none',
    'REASON: a female tennis player serving on a hard court, no name visible',
    'SCORE: 5',
].join('\n');

const personVerdict = _parseWindowValidation(GENERIC_TENNIS_VERDICT, { mediaHunter: personProfile });
const topicVerdict = _parseWindowValidation(GENERIC_TENNIS_VERDICT, { mediaHunter: topicProfile });

check(personVerdict.ok === true,
    `on-subject footage must PASS a person-subject scene (score ${personVerdict.score}, ok=${personVerdict.ok})`);
check(personVerdict.score >= relaxedFloor,
    `person-subject score ${personVerdict.score} must clear the relaxed floor ${relaxedFloor}`);

// Same clip, no explicit decision → the strict scene falls back to the >=6 bar.
const NO_DECISION_VERDICT = [
    'ISSUES: none',
    'REASON: a female tennis player serving on a hard court, no name visible',
    'SCORE: 5',
].join('\n');
const personNoDecision = _parseWindowValidation(NO_DECISION_VERDICT, { mediaHunter: personProfile });
const topicNoDecision = _parseWindowValidation(NO_DECISION_VERDICT, { mediaHunter: topicProfile });
check(personNoDecision.ok === true,
    `a 5/10 on-subject clip must pass a person-subject scene (got ok=${personNoDecision.ok})`);
check(topicNoDecision.ok === false,
    `a 5/10 clip must still FAIL a topic scene at the strict floor (got ok=${topicNoDecision.ok})`);

// ── 4. Containment: relaxed is not "accept anything" ────────────────────────
const OFF_TOPIC_VERDICT = [
    'ISSUES: wrong subject',
    'REASON: an empty tropical beach at sunset, no people',
    'SCORE: 2',
].join('\n');
check(_parseWindowValidation(OFF_TOPIC_VERDICT, { mediaHunter: personProfile }).ok === false,
    'clearly off-subject footage must still be rejected on a person-subject scene');

const ANCHOR_VERDICT = [
    'WINDOW: PASS',
    'ISSUES: news anchor at studio desk, news ticker',
    'REASON: studio presenter reading the result',
    'SCORE: 8',
].join('\n');
check(_parseWindowValidation(ANCHOR_VERDICT, { mediaHunter: personProfile }).ok === false,
    'anchors/tickers must still hard-reject on a person-subject scene, at any score');

// ── 5. The mandatory-identity cap must soften only for the main character ───
check(personSubjectCoversMandatory(personProfile.personSubject, ['Victoria Mboko']) === true,
    'a mandatory entity that IS the main character must soften the cap');
check(personSubjectCoversMandatory(personProfile.personSubject, ['Victoria Mboko', 'Wilson racket']) === false,
    'a scene that also demands a product must keep the strict mandatory cap');
check(personSubjectCoversMandatory(topicProfile.personSubject, ['Pont du Gard']) === false,
    'a topic scene must never soften the mandatory cap');

// ── 6. The rule text actually reaches the judge ─────────────────────────────
const rule = renderPersonSubjectRule(personProfile.personSubject);
check(/PERSON-SUBJECT SCENE/.test(rule), 'the person-subject rule must be rendered for a person scene');
check(/Victoria Mboko/.test(rule), 'the rule must name the main character');
check(/BONUS, not a requirement/.test(rule), 'the rule must state that exact-moment accuracy is a bonus');
check(/anchors|presenters|news tickers/i.test(rule),
    'the rule must still name the broadcast packaging that stays rejected');
check(renderPersonSubjectRule(topicProfile.personSubject) === '',
    'no person-subject rule may be injected into a topic scene prompt');

// ── 7. Kill switch ──────────────────────────────────────────────────────────
const prior = process.env.FOOTAGE_PERSON_SUBJECT_RELAXED;
process.env.FOOTAGE_PERSON_SUBJECT_RELAXED = 'off';
check(detectPersonSubject({ scene: personScene, scriptContext: PERSON_CONTEXT }).active === false,
    'FOOTAGE_PERSON_SUBJECT_RELAXED=off must disable the relaxed bar entirely');
if (prior === undefined) delete process.env.FOOTAGE_PERSON_SUBJECT_RELAXED;
else process.env.FOOTAGE_PERSON_SUBJECT_RELAXED = prior;

if (failures.length) {
    console.error(`person-subject-scoring: FAILED (${failures.length}/${checks})`);
    for (const failure of failures) console.error(`  ✗ ${failure}`);
    process.exit(1);
}
console.log(`person-subject-scoring: OK (${checks} checks)`);
