#!/usr/bin/env node
'use strict';

/**
 * Regression gate for the borrow rung (src/media/footage-borrow.js).
 *
 * THE DEFECT IT LOCKS OUT (found 2026-08-04)
 *
 * The coverage ladder ended one rung too early. A scene that found nothing went
 * to `coverage-rescue.js`; if the rescue also came back empty, the build painted
 * a generated slide reading "DOCUMENTARY CONTEXT" and shipped it as the scene's
 * visual — while the same build was holding twenty real, downloaded,
 * vision-scored clips it had won for other scenes of the SAME video. The 2026-08-04
 * 10:33 build shipped three of those cards with a full donor bank available.
 *
 * `footage-borrow.js` closes that gap. These checks pin the four properties that
 * make it safe rather than merely non-empty:
 *
 *   1. It picks by TOPIC, not by proximity — otherwise it is just "repeat the
 *      previous shot", which reads as a stutter.
 *   2. It hands out a different second of the source each time, so two scenes
 *      sharing one file are not literally the same footage twice.
 *   3. It cannot chain: a borrowed scene must never become a donor, or one clip
 *      spreads across the whole video.
 *   4. It reports itself. A borrowed scene is covered, but counted apart from
 *      found footage — the coverage module exists precisely to stop a build
 *      claiming success it did not earn.
 *
 * It also enforces the standing rule that media fixes are one global mechanism
 * with per-topic inputs: no niche branches, no fixed word lists, no flat
 * relevance threshold. Every judgement here is learned from the run's own text.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

let failures = 0;
let checks = 0;
const pending = [];

function check(label, fn) {
    checks++;
    try {
        const r = fn();
        if (r && typeof r.then === 'function') {
            pending.push(r.then(
                () => console.log(`  ✓ ${label}`),
                (err) => { failures++; console.log(`  ✗ ${label}\n      ${err.message}`); }
            ));
            return;
        }
        console.log(`  ✓ ${label}`);
    } catch (err) {
        failures++;
        console.log(`  ✗ ${label}\n      ${err.message}`);
    }
}

console.log('\n[footage-borrow] borrow real footage instead of drawing a card\n');

const borrow = require(path.join(ROOT, 'src', 'media', 'footage-borrow.js'));
const coverage = require(path.join(ROOT, 'src', 'media', 'scene-coverage.js'));
const BORROW_SRC = fs.readFileSync(path.join(ROOT, 'src', 'media', 'footage-borrow.js'), 'utf8');
const BV = fs.readFileSync(path.join(ROOT, 'src', 'pipeline', 'build-video.js'), 'utf8');

// Real files on disk: the donor bank deliberately refuses a scene whose media
// has vanished, so the fixtures have to exist.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yta-borrow-'));
function fixture(name, bytes = 4096) {
    const p = path.join(TMP, name);
    fs.writeFileSync(p, Buffer.alloc(bytes, 7));
    return p;
}

function donorScene(index, { start, keyword, file, type = 'video', offset = 0, duration = 6 }) {
    return {
        index,
        startTime: start,
        endTime: start + duration,
        keyword,
        text: keyword,
        mediaFile: file,
        mediaType: type,
        mediaExtension: path.extname(file),
        mediaOffset: offset,
        mediaWidth: 1920,
        mediaHeight: 1080,
        sourceProvider: 'Pexels',
        mediaDownloadStatus: 'accepted',
    };
}

function placeholderScene(index, { start, keyword, duration = 6 }) {
    return {
        index,
        startTime: start,
        endTime: start + duration,
        keyword,
        text: keyword,
        mediaFile: path.join(TMP, `card-${index}.png`),
        mediaType: 'image',
        sourceProvider: 'agentic visual fallback',
        mediaDownloadStatus: 'agenticGraphicFallback',
        agenticFallback: true,
    };
}

const FAKE_PROBE = async () => 60;

// ── 1. Word importance is learned from the run, not from a list ───────────────

check('the more scenes a word appears in, the less it is allowed to count', () => {
    // A video is about one thing, so its subject word is in every scene. If that
    // word carried full weight, every scene would look "related" to every other
    // and the borrow would degenerate into picking whatever is nearest. Rarity
    // has to buy weight — monotonically, with no list of words to ignore.
    const docs = [];
    for (let i = 0; i < 12; i++) {
        docs.push(borrow._tokens(`roman scene${i} ${i < 6 ? 'battle' : ''} ${i < 2 ? 'legion' : ''}`));
    }
    const idf = borrow._buildIdf(docs);
    const everywhere = idf.get('roman');   // 12 of 12
    const half = idf.get('battle');        //  6 of 12
    const rare = idf.get('legion');        //  2 of 12
    assert.ok(rare > half && half > everywhere,
        `weight must fall as a word spreads: legion=${rare}, battle=${half}, roman=${everywhere}`);
    assert.ok(rare > everywhere * 2,
        `a word in 2 of 12 scenes must be worth more than double one in all 12: ${rare} vs ${everywhere}`);
});

check('similarity is 0 for unrelated text and high for the same subject', () => {
    const docs = [
        borrow._tokens('aircraft carrier flight deck'),
        borrow._tokens('aircraft carrier jet launch'),
        borrow._tokens('bakery sourdough bread oven'),
    ];
    const idf = borrow._buildIdf(docs);
    const related = borrow._similarity(docs[0], docs[1], idf);
    const unrelated = borrow._similarity(docs[0], docs[2], idf);
    assert.strictEqual(unrelated, 0, 'scenes with no shared word must score 0');
    assert.ok(related > 0, 'scenes sharing a subject must score above 0');
});

// ── 2. It picks by topic, not by whatever is nearest ──────────────────────────

check('the topically closest donor wins over the one sitting right next door', async () => {
    const near = fixture('near.mp4');
    const far = fixture('far.mp4');
    const scenes = [
        donorScene(1, { start: 0, keyword: 'bakery sourdough bread oven', file: near }),
        placeholderScene(2, { start: 6, keyword: 'aircraft carrier flight deck' }),
        donorScene(3, { start: 40, keyword: 'aircraft carrier jet launch', file: far }),
    ];
    const res = await borrow.borrowForUncovered({
        scenes, graphics: [], log: () => {}, probeDuration: FAKE_PROBE,
    });
    assert.strictEqual(res.borrowed, 1, `expected 1 borrow, got ${res.borrowed}`);
    assert.strictEqual(scenes[1].borrowedFromScene, 3,
        'the carrier scene borrowed the bakery clip from next door instead of the carrier clip further away');
    assert.strictEqual(scenes[1].mediaFile, far);
    assert.strictEqual(res.topical, 1, 'a clear subject match must be reported as topical, not weak');
});

// ── 3. Borrowed footage is not the same footage ───────────────────────────────

check('a borrowed clip starts at a different second than its donor', async () => {
    const file = fixture('shared.mp4');
    const scenes = [
        donorScene(1, { start: 0, keyword: 'harbour crane container ship', file, offset: 2, duration: 6 }),
        placeholderScene(2, { start: 30, keyword: 'harbour crane container dock', duration: 6 }),
    ];
    await borrow.borrowForUncovered({ scenes, graphics: [], log: () => {}, probeDuration: FAKE_PROBE });
    assert.strictEqual(scenes[1].mediaFile, file);
    const donorWindow = [2, 8];
    const off = Number(scenes[1].mediaOffset);
    assert.ok(Number.isFinite(off), 'the borrower got no in-point at all');
    assert.ok(off >= donorWindow[1] || off + 6 <= donorWindow[0],
        `borrower window [${off}, ${off + 6}] overlaps the donor's [${donorWindow}] — that is the same footage twice`);
});

check('two scenes borrowing one file get two different in-points', async () => {
    const file = fixture('shared2.mp4');
    const scenes = [
        donorScene(1, { start: 0, keyword: 'volcano eruption lava flow', file, offset: 0, duration: 5 }),
        placeholderScene(2, { start: 20, keyword: 'volcano eruption ash cloud', duration: 5 }),
        placeholderScene(3, { start: 40, keyword: 'volcano lava crater rim', duration: 5 }),
    ];
    const res = await borrow.borrowForUncovered({
        scenes, graphics: [], log: () => {}, probeDuration: FAKE_PROBE,
    });
    assert.strictEqual(res.borrowed, 2, `expected 2 borrows, got ${res.borrowed}`);
    assert.notStrictEqual(Number(scenes[1].mediaOffset), Number(scenes[2].mediaOffset),
        'both borrowers took the same second of the same clip');
});

check('a borrowed still gets a different camera move instead of an in-point', async () => {
    const file = fixture('still.jpg');
    const scenes = [
        donorScene(1, { start: 0, keyword: 'desert dune sand ridge', file, type: 'image' }),
        placeholderScene(2, { start: 20, keyword: 'desert dune sand wind' }),
    ];
    await borrow.borrowForUncovered({ scenes, graphics: [], log: () => {}, probeDuration: FAKE_PROBE });
    assert.strictEqual(scenes[1].mediaType, 'image');
    assert.ok(Number(scenes[1].kenBurnsSpeed) > 0,
        'a reused still with the identical move is a visible repeat — it must get its own speed');
});

// ── 4. It cannot chain, and it reports itself ─────────────────────────────────

check('a borrowed scene never becomes a donor for the next borrow', async () => {
    const file = fixture('one.mp4');
    const scenes = [
        donorScene(1, { start: 0, keyword: 'arctic ice shelf glacier', file }),
        placeholderScene(2, { start: 20, keyword: 'arctic ice shelf calving' }),
    ];
    await borrow.borrowForUncovered({ scenes, graphics: [], log: () => {}, probeDuration: FAKE_PROBE });
    assert.strictEqual(coverage.classifyScene(scenes[1], { graphics: [] }).kind, 'borrowed');
    assert.ok(coverage.isBorrowedMedia(scenes[1]), 'the borrow marker did not survive onto the scene');
    // Second pass: the only uncovered scene must find scene 1, never scene 2.
    scenes.push(placeholderScene(3, { start: 40, keyword: 'arctic ice shelf survey' }));
    await borrow.borrowForUncovered({ scenes, graphics: [], log: () => {}, probeDuration: FAKE_PROBE });
    assert.strictEqual(scenes[2].borrowedFromScene, 1,
        `scene 3 borrowed from scene ${scenes[2].borrowedFromScene} — borrowing from a borrower spreads one clip everywhere`);
});

check('a borrowed scene counts as covered but is NOT counted as found footage', async () => {
    const file = fixture('audit.mp4');
    const scenes = [
        donorScene(1, { start: 0, keyword: 'wind turbine blade offshore', file }),
        placeholderScene(2, { start: 20, keyword: 'wind turbine offshore array' }),
    ];
    const before = coverage.summarize(scenes, { graphics: [] });
    assert.strictEqual(before.uncovered, 1, 'the placeholder must start out uncovered');
    await borrow.borrowForUncovered({ scenes, graphics: [], log: () => {}, probeDuration: FAKE_PROBE });
    const after = coverage.summarize(scenes, { graphics: [] });
    assert.strictEqual(after.uncovered, 0, 'the borrowed scene should now be covered');
    assert.strictEqual(after.borrowed, 1, 'the audit must count the borrow');
    assert.strictEqual(after.footage, 1,
        `found-footage count is ${after.footage} — a borrow must not be reported as something the media system found`);
});

// ── 5. The two other ways a scene ends up empty ───────────────────────────────

check('an orphaned-graphic scene has its dead graphic marker cleared, or nothing draws it', async () => {
    const file = fixture('orphan.mp4');
    const scenes = [
        donorScene(1, { start: 0, keyword: 'stock market trading floor', file }),
        {
            index: 2, startTime: 20, endTime: 26,
            keyword: 'stock market index chart', text: 'stock market index chart',
            fullscreenMG: 'statCard: inflation',
        },
    ];
    await borrow.borrowForUncovered({ scenes, graphics: [], log: () => {}, probeDuration: FAKE_PROBE });
    assert.ok(scenes[1].mediaFile, 'the orphaned scene got no footage');
    assert.ok(!scenes[1].fullscreenMG,
        'fullscreenMG still set — the carve and framing stages skip such scenes, so the footage would never be drawn');
});

check('with no footage anywhere the build changes nothing and keeps its card', async () => {
    const scenes = [
        placeholderScene(1, { start: 0, keyword: 'anything at all' }),
        placeholderScene(2, { start: 20, keyword: 'anything else' }),
    ];
    const res = await borrow.borrowForUncovered({
        scenes, graphics: [], log: () => {}, probeDuration: FAKE_PROBE,
    });
    assert.strictEqual(res.borrowed, 0, 'there was nothing to borrow — it must not invent a file');
    assert.strictEqual(res.stillBroken.length, 2);
    assert.strictEqual(coverage.classifyScene(scenes[0], { graphics: [] }).kind, 'placeholder');
});

check('a scene already covered by a live fullscreen graphic is left alone', async () => {
    const file = fixture('covered.mp4');
    const graphic = { startTime: 20, endTime: 26, type: 'quoteCard' };
    const scenes = [
        donorScene(1, { start: 0, keyword: 'railway tunnel construction', file }),
        { index: 2, startTime: 20, endTime: 26, keyword: 'railway tunnel bore', fullscreenMG: 'quoteCard' },
    ];
    const res = await borrow.borrowForUncovered({
        scenes, graphics: [graphic], log: () => {}, probeDuration: FAKE_PROBE,
    });
    assert.strictEqual(res.borrowed, 0, 'a scene the graphic already covers must not be handed footage');
    assert.ok(!scenes[1].mediaFile);
});

// ── 6. One global mechanism — no niche branches, no fixed vocabulary ──────────

check('the borrow logic contains no niche branch and no hardcoded word list', () => {
    const body = BORROW_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/niche\s*(===|==|\.startsWith|\.includes)/.test(body),
        'a niche branch appeared — media fixes must be one global mechanism with per-topic inputs');
    assert.ok(!/\b(STOP_?WORDS|STOPWORDS)\b/i.test(body),
        'a stop-word list appeared — importance is learned from the run so it works in every language');
    assert.ok(/_buildIdf\(/.test(body) && /_median\(/.test(body),
        'the run-learned weighting or the run-learned relevance bar is gone — a fixed threshold '
        + 'is banned as strictly as a per-niche branch');
});

check('the relevance bar is derived from this run, never a literal', () => {
    const barLine = BORROW_SRC.match(/const bar = ([^;]+);/);
    assert.ok(barLine, 'the relevance bar assignment was not found');
    assert.ok(/_median\(pairScores\)/.test(barLine[1]),
        `the bar is "${barLine[1].trim()}" — it must come from this video's own similarity spread`);
});

// ── 7. Wiring: after the rescue, before the audit ─────────────────────────────

check('the pipeline calls the borrow after the rescue and before the audit', () => {
    const iBorrowReq = BV.indexOf("require('../media/footage-borrow')");
    const iRescue = BV.indexOf('rescueUncovered({');
    const iBorrow = BV.indexOf('borrowForUncovered({');
    const iSummarize = BV.indexOf("require('../media/scene-coverage')");
    assert.ok(iBorrowReq > 0, 'build-video.js never requires footage-borrow');
    assert.ok(iRescue > 0 && iBorrow > iRescue,
        'the borrow must run AFTER the rescue — searching for a scene\'s own footage always beats reusing someone else\'s');
    assert.ok(iSummarize > iBorrow,
        'the coverage audit must run AFTER the borrow, or it reports scenes as broken that were just filled');
});

check('the audit line reports borrowed scenes separately from found ones', () => {
    assert.ok(/cover\.borrowed/.test(BV),
        'the audit line does not mention the borrow count — a build could claim full coverage while half of it is reuse');
    assert.ok(!/continuity reuse is disabled/.test(BV),
        'the log still says continuity reuse is disabled, which is now false');
});

check('the give-up card paints no fixed filler text, only this scene\'s own words', () => {
    // Whatever survives on the rare card that still ships must describe THIS
    // scene. A constant string — an eyebrow, a lane name, a stock label — is the
    // clearest signal to a viewer that they are looking at generated filler, and
    // it is identical on every card in every video.
    const fm = fs.readFileSync(path.join(ROOT, 'src', 'media', 'footage-manager.js'), 'utf8');
    const fn = fm.slice(fm.indexOf('function createAgenticGraphicFallback'));
    const drawn = fn.slice(0, fn.indexOf('\nfunction ', 10))
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const filler of ['DOCUMENTARY CONTEXT', 'contextual visual']) {
        assert.ok(!drawn.includes(filler),
            `the card still carries the fixed text "${filler}" — it says nothing about the scene `
            + 'and appears identically in every video');
    }
    assert.ok(/key === titleKey/.test(drawn),
        'the chip row no longer skips a label that just repeats the title — the card would say the same thing twice');
});

Promise.all(pending).then(() => {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
    console.log(`\n[footage-borrow] ${checks - failures}/${checks} checks passed`);
    if (failures) {
        console.log(`[footage-borrow] FAILED — ${failures} check(s)\n`);
        process.exit(1);
    }
    console.log('[footage-borrow] OK\n');
});
