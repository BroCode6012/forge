#!/usr/bin/env node
'use strict';

/**
 * Regression gate for the PRE-DOWNLOAD THUMBNAIL SCREEN.
 *
 * THE BUG THIS LOCKS OUT (measured on the 2026-07-31 build)
 *   851 clips were downloaded and then vision-judged; 783 were rejected. The
 *   grid pre-screen that exists to prevent exactly that ran ZERO times, for two
 *   independent reasons that each looked like the whole story on their own:
 *
 *     1. the call site was gated on `providerKey === 'storyblocks'`, and
 *     2. only storyblocks-video.js and youtube-video.js ever published a
 *        `_thumbUrl`, so even ungated there was nothing to look at.
 *
 *   Fixing either half alone changes nothing. This file asserts BOTH halves,
 *   because a future edit that quietly reverts one of them would restore the
 *   original symptom while every other check still passed.
 *
 * THE PROPERTY THAT MUST NEVER REGRESS
 *   The screen is a RANKING, NOT A GATE. A grid of numbered tiles is the exact
 *   shape where a vision model mis-binds its verdict to the wrong tile number
 *   (the Storyboard Scout measured 2/8 on "which cell shows X" against 17/17 on
 *   plain presence). Under a gate one mis-bound number silently deletes a good
 *   clip; under a ranking the worst case is a slightly wrong order. The stated
 *   goal is "0 failures or not-found in less time" — speed may never be bought
 *   with a lost clip. Section C proves the screen cannot drop, and cannot even
 *   reorder unless it confirmed a winner first.
 *
 * No network, no AWS, no GPU: the vision transport and the thumbnail fetcher
 * are both stubbed.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

let failures = 0;
let checks = 0;
function check(label, fn) {
    checks++;
    try {
        fn();
        console.log(`  ✓ ${label}`);
    } catch (err) {
        failures++;
        console.log(`  ✗ ${label}\n      ${err.message}`);
    }
}
async function checkAsync(label, fn) {
    checks++;
    try {
        await fn();
        console.log(`  ✓ ${label}`);
    } catch (err) {
        failures++;
        console.log(`  ✗ ${label}\n      ${err.message}`);
    }
}

const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

// ─────────────────────────────────────────────────────────────────────────────
// Stub BEFORE requiring thumbnail-vision: it destructures both at module load.
// ─────────────────────────────────────────────────────────────────────────────
const stub = (relPath, exports) => {
    const resolved = require.resolve(path.join(ROOT, relPath));
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, children: [], paths: [], exports };
    return resolved;
};

let VISION_CALLS = 0;
let VISION_REPLY = '';          // string, or an Error to throw
let LAST_PROMPT = '';
stub('src/brain/ai-provider.js', {
    callVisionAI: async (prompt) => {
        VISION_CALLS++;
        LAST_PROMPT = String(prompt || '');
        if (VISION_REPLY instanceof Error) throw VISION_REPLY;
        return VISION_REPLY;
    },
    callVideoAI: async () => { throw new Error('stub: no network in verify'); },
    callAI: async () => { throw new Error('stub: no network in verify'); },
    isVisionAIAvailable: () => true,
    getVisionProviderChain: () => ['stub'],
});

let FETCHES = 0;
stub('src/security/safe-download.js', {
    requestSafeBuffer: async () => { FETCHES++; return { data: Buffer.alloc(64, 7) }; },
    safeDownload: async () => { throw new Error('stub: no network in verify'); },
});

const {
    screenThumbnailGrid,
    resetThumbnailVisionCache,
} = require(path.join(ROOT, 'src', 'vision', 'thumbnail-vision.js'));

const CONTRACT = { enabled: true, target: 'a wind turbine on a ridge', mustShow: ['wind turbine'], mustNotShow: ['text overlay'] };
const scene = (i = 1) => ({ index: i, text: 'Wind turbines now out-produce the coal plants they replaced.' });
const cand = (n) => ({ id: `c${n}`, url: `https://example.test/full/${n}.mp4`, title: `candidate ${n}`, _thumbUrl: `https://example.test/thumb/${n}.jpg`, _provider: 'pexels' });
const list = (n) => Array.from({ length: n }, (_, i) => cand(i + 1));
const titles = (arr) => arr.map(r => r.title).join(',');

const runScreen = (results, sceneObj = scene(), contract = CONTRACT) =>
    screenThumbnailGrid(results, contract, sceneObj, { providerName: 'Pexels', niche: 'explainer.tech' });

// ═════════════════════════════════════════════════════════════════════════════
console.log('\nA) Every volume provider publishes a free preview picture');
// ═════════════════════════════════════════════════════════════════════════════
// Without this, the screen has nothing to look at and silently no-ops — which
// is precisely how it managed to run zero times across an 851-clip build.

const PROVIDERS = [
    'pexels-video.js',
    'pixabay-video.js',
    'pexels-image.js',
    'pixabay-image.js',
    'bing-image.js',
    'brave-image.js',
    'storyblocks-video.js',
    'youtube-video.js',
];
for (const file of PROVIDERS) {
    check(`${file} publishes _thumbUrl`, () => {
        const src = read('src', 'media', 'providers', file);
        assert.ok(/_thumbUrl\s*:/.test(src), `${file} no longer sets _thumbUrl — the pre-download screen goes blind for this provider`);
    });
}

check('preview-thumb.js helper exists and exports both builders', () => {
    const helper = require(path.join(ROOT, 'src', 'media', 'providers', 'preview-thumb.js'));
    assert.strictEqual(typeof helper.firstThumbUrl, 'function', 'firstThumbUrl missing');
    assert.strictEqual(typeof helper.midPreviewFrame, 'function', 'midPreviewFrame missing');
    assert.strictEqual(helper.firstThumbUrl('', null, 'not a url', 'https://ok.test/a.jpg'), 'https://ok.test/a.jpg');
    assert.strictEqual(helper.firstThumbUrl('', null, undefined), '', 'must return empty string, never undefined');
    assert.strictEqual(helper.midPreviewFrame([{ picture: 'https://ok.test/1.jpg' }, { picture: 'https://ok.test/2.jpg' }]), 'https://ok.test/2.jpg');
    assert.strictEqual(helper.midPreviewFrame([]), '', 'empty frame list must not throw');
});

check('image providers never publish the full-size URL as its own "thumbnail"', () => {
    // Screening a thumbnail that IS the candidate downloads the exact bytes the
    // screen exists to defer — it would cost money and save none.
    for (const file of ['bing-image.js', 'brave-image.js']) {
        const src = read('src', 'media', 'providers', file);
        assert.ok(
            /thumb\s*&&\s*thumb\s*!==\s*url/.test(src),
            `${file} lost its "thumb !== url" guard — screening would pre-pay for the full image`,
        );
    }
    const pixabay = read('src', 'media', 'providers', 'pixabay-image.js');
    assert.ok(
        /hit\.largeImageURL\s*\?\s*hit\.webformatURL/.test(pixabay),
        'pixabay-image.js lost the guard that only offers webformatURL when the candidate is the larger original',
    );
});

// ═════════════════════════════════════════════════════════════════════════════
console.log('\nB) The call site is provider-agnostic and runs at most once');
// ═════════════════════════════════════════════════════════════════════════════

const fm = read('src', 'media', 'footage-manager.js');

check('footage-manager calls the generic screen', () => {
    assert.ok(/screenThumbnailGrid:\s*_thumbnailScreen/.test(fm), 'screenThumbnailGrid import missing');
    assert.ok(/await\s+_thumbnailScreen\(/.test(fm), 'the screen is imported but never called');
});

check('the screen block names no provider (works for every lane, present and future)', () => {
    const start = fm.indexOf('await _thumbnailScreen(');
    assert.ok(start > 0, 'call site not found');
    const block = fm.slice(fm.lastIndexOf('if (results.length > 1', start), fm.indexOf('_reserveUndersizedTail', start));
    assert.ok(
        !/providerKey\s*===\s*['"]/.test(block),
        'the screen is gated on a provider name again — that is the exact gate that made it run zero times',
    );
});

check('the screen is skipped when a provider already looked (no double billing)', () => {
    assert.ok(/let\s+preDownloadLookApplied\s*=\s*false/.test(fm), 'preDownloadLookApplied flag not declared');
    const sets = fm.match(/preDownloadLookApplied\s*=\s*true/g) || [];
    assert.ok(
        sets.length >= 4,
        `only ${sets.length} pre-download-look branches set the flag; expected >= 4 (2 Storyblocks grids, YouTube SERP, Storyboard Screen)`,
    );
    const start = fm.indexOf('await _thumbnailScreen(');
    const block = fm.slice(fm.lastIndexOf('if (results.length > 1', start), start);
    assert.ok(/!preDownloadLookApplied/.test(block), 'the screen no longer checks the flag — providers that already looked would pay twice');
});

check('the screen runs before the image size-tail keeps the last word', () => {
    const screenAt = fm.indexOf('await _thumbnailScreen(');
    const tailAt = fm.indexOf('_reserveUndersizedTail(results', screenAt);
    assert.ok(tailAt > screenAt, '_reserveUndersizedTail must run after the screen so big-beats-small still decides images');
});

check('the screen has a kill switch and a budget floor', () => {
    const tv = read('src', 'vision', 'thumbnail-vision.js');
    assert.ok(/MEDIA_THUMBNAIL_SCREEN\b/.test(tv), 'MEDIA_THUMBNAIL_SCREEN kill switch missing');
    assert.ok(/THUMBNAIL_SCREEN_MIN_BUDGET_MS/.test(fm), 'the screen is not budget-gated like its neighbours');
});

// ═════════════════════════════════════════════════════════════════════════════
console.log('\nC) RANKING, NOT A GATE — the property that protects every clip');
// ═════════════════════════════════════════════════════════════════════════════

(async () => {
    const reset = () => { resetThumbnailVisionCache(); VISION_CALLS = 0; FETCHES = 0; delete process.env.MEDIA_THUMBNAIL_SCREEN; };

    await checkAsync('never drops a candidate, even when vision says NO to most', async () => {
        reset();
        VISION_REPLY = ['1|NO|wrong subject', '2|YES|turbine on ridge', '3|NO|indoor shot', '4|NO|crowd'].join('\n');
        const input = list(4);
        const out = await runScreen(input);
        assert.strictEqual(out.ranked.length, input.length, 'the screen dropped candidates — it must only reorder');
        for (const r of input) assert.ok(out.ranked.includes(r), `lost candidate ${r.title}`);
    });

    await checkAsync('promotes the confirmed candidate above the mismatches', async () => {
        reset();
        VISION_REPLY = ['1|NO|wrong subject', '2|NO|indoor', '3|YES|turbine on ridge', '4|UNSURE|too dark'].join('\n');
        const out = await runScreen(list(4));
        assert.strictEqual(out.ranked[0].title, 'candidate 3', `expected the YES first, got "${out.ranked[0].title}"`);
        assert.strictEqual(out.saw, 1);
        assert.strictEqual(out.missed, 2);
        assert.strictEqual(titles(out.ranked), 'candidate 3,candidate 4,candidate 1,candidate 2',
            'bands must be YES, then unsure/unknown, then NO');
    });

    await checkAsync('keeps every upstream ranker\'s order inside each band (stable sort)', async () => {
        reset();
        VISION_REPLY = ['1|YES|ok', '2|NO|wrong', '3|YES|ok', '4|NO|wrong', '5|UNSURE|dark', '6|UNSURE|dark'].join('\n');
        const out = await runScreen(list(6));
        assert.strictEqual(titles(out.ranked), 'candidate 1,candidate 3,candidate 5,candidate 6,candidate 2,candidate 4',
            'ties inside a band must keep the order every earlier ranker chose');
    });

    await checkAsync('NO-POSITIVES GUARD: confirms nothing -> changes nothing', async () => {
        reset();
        VISION_REPLY = ['1|NO|wrong', '2|NO|wrong', '3|NO|wrong', '4|UNSURE|dark'].join('\n');
        const input = list(4);
        const out = await runScreen(input);
        assert.strictEqual(out.saw, 0);
        assert.strictEqual(titles(out.ranked), titles(input),
            'with no confirmed winner the screen must not trust its own negatives');
    });

    await checkAsync('a vision failure leaves the list exactly as it arrived', async () => {
        reset();
        VISION_REPLY = new Error('vision backend down');
        const input = list(4);
        const out = await runScreen(input);
        assert.strictEqual(titles(out.ranked), titles(input));
        assert.strictEqual(out.saw, 0);
        assert.strictEqual(out.log, '', 'a failed screen must stay silent, not report a result it never got');
    });

    await checkAsync('unreadable vision output is neutral, never a demotion', async () => {
        reset();
        VISION_REPLY = 'Sure! Here are my thoughts about the images you sent.';
        const input = list(4);
        const out = await runScreen(input);
        assert.strictEqual(titles(out.ranked), titles(input), 'an unparseable reply must not reorder anything');
        assert.strictEqual(out.missed, 0, 'an unparseable reply must not count as a rejection');
    });

    await checkAsync('`confirmed` lists exactly the candidates vision said YES to', async () => {
        reset();
        VISION_REPLY = ['1|NO|wrong', '2|YES|turbine', '3|YES|turbine', '4|UNSURE|dark'].join('\n');
        const input = list(4);
        const out = await runScreen(input);
        assert.strictEqual(out.confirmed.length, 2);
        assert.ok(out.confirmed.includes(input[1]) && out.confirmed.includes(input[2]),
            'confirmed must hold the actual result objects so the caller never infers them by position');
        assert.ok(!out.confirmed.includes(input[0]), 'a NO must never appear in confirmed');
    });

    // ── cost guards: one call per grid, and never a call it cannot use ──
    await checkAsync('ONE vision call for a whole grid of 20', async () => {
        reset();
        VISION_REPLY = Array.from({ length: 20 }, (_, i) => `${i + 1}|${i === 0 ? 'YES' : 'NO'}|r`).join('\n');
        await runScreen(list(20));
        assert.strictEqual(VISION_CALLS, 1, `20 candidates cost ${VISION_CALLS} vision calls; the whole point is 1`);
        assert.strictEqual(FETCHES, 20, 'every thumbnail should be fetched once');
    });

    await checkAsync('kill switch MEDIA_THUMBNAIL_SCREEN=0 spends nothing', async () => {
        reset();
        process.env.MEDIA_THUMBNAIL_SCREEN = '0';
        VISION_REPLY = '1|YES|x';
        const input = list(4);
        const out = await runScreen(input);
        assert.strictEqual(VISION_CALLS, 0, 'kill switch did not stop the call');
        assert.strictEqual(titles(out.ranked), titles(input));
        delete process.env.MEDIA_THUMBNAIL_SCREEN;
    });

    await checkAsync('no visual contract -> no call (nothing to compare a picture against)', async () => {
        reset();
        VISION_REPLY = '1|YES|x';
        await runScreen(list(4), scene(), { enabled: false, target: 'x' });
        assert.strictEqual(VISION_CALLS, 0);
    });

    await checkAsync('candidates without previews -> no call', async () => {
        reset();
        VISION_REPLY = '1|YES|x';
        const bare = list(4).map(r => ({ ...r, _thumbUrl: '' }));
        const out = await runScreen(bare);
        assert.strictEqual(VISION_CALLS, 0, 'spent a vision call on an empty grid');
        assert.strictEqual(titles(out.ranked), titles(bare));
    });

    await checkAsync('a single candidate is never screened (nothing to reorder)', async () => {
        reset();
        VISION_REPLY = '1|YES|x';
        await runScreen(list(1));
        assert.strictEqual(VISION_CALLS, 0);
    });

    await checkAsync('verdicts are cached per scene — a re-run costs nothing', async () => {
        reset();
        VISION_REPLY = ['1|YES|turbine', '2|NO|wrong', '3|NO|wrong', '4|NO|wrong'].join('\n');
        const input = list(4);
        const first = await runScreen(input);
        assert.strictEqual(VISION_CALLS, 1);
        const second = await runScreen(input);
        assert.strictEqual(VISION_CALLS, 1, 'the same scene re-screened and paid for the same answer twice');
        assert.strictEqual(titles(second.ranked), titles(first.ranked), 'the cached run must reach the same order');
    });

    await checkAsync('the screen cache is separate from the reject-gate cache', async () => {
        // A gate verdict ("is this packaged content?") and a screen verdict
        // ("does this show the subject?") answer different questions. Sharing
        // one cache would let a ranking hint become a silent rejection.
        const tv = read('src', 'vision', 'thumbnail-vision.js');
        assert.ok(/const\s+_screenCache\s*=\s*new Map\(\)/.test(tv), '_screenCache missing');
        assert.ok(/_screenCache\.clear\(\)/.test(tv), 'resetThumbnailVisionCache does not clear the screen cache');
    });

    await checkAsync('the prompt tells the model to prefer UNSURE over a wrong NO', async () => {
        reset();
        VISION_REPLY = '1|YES|x\n2|NO|y';
        await runScreen(list(2));
        assert.ok(/Prefer UNSURE over NO/i.test(LAST_PROMPT), 'the anti-false-negative instruction was removed from the prompt');
        assert.ok(/MUST AVOID/.test(LAST_PROMPT), 'the prompt no longer carries the contract');
    });

    console.log(`\n${failures === 0 ? '✅' : '❌'} Thumbnail Screen: ${checks - failures}/${checks} checks passed`);
    process.exit(failures === 0 ? 0 : 1);
})();
