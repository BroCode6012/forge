#!/usr/bin/env node
/**
 * VERIFY: a slow page setup can never be mistaken for a stalled render.
 *
 * Background (measured in the 2026-07-31 render, 122 media / 7789 frames):
 * the hyperframes CLI guards frame capture with a stall watchdog whose clock
 * starts when capture is REQUESTED -- before the workers launch their browsers,
 * navigate the page and inject every clip -- and only resets on real frame
 * progress. Its default budget is 60s. The four workers in that render reported
 * "media + fonts + tailwind ready" at 44s, 45s, 64s and 82s, so the watchdog
 * fired mid-setup, aborted at 0/7789 frames, and main.js fell all the way back
 * to the 1-worker software tier for the entire render. Nothing was stalled.
 *
 * That failure is deterministic, not flaky: the longer the video, the more
 * clips, the longer setup takes, the more certain the demotion. Left alone it
 * silently caps every long render at the slowest path the app has.
 *
 * This check pins BOTH halves of the fix -- the app-side budget and the
 * upstream contract it depends on -- because the dangerous regression is the
 * silent one: if hyperframes renames the env var or the stall message, the
 * override becomes a no-op and nothing else in the app would notice.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const MAIN_PATH = path.join(ROOT, 'main.js');
const CLI_PATH = path.join(ROOT, 'node_modules', 'hyperframes', 'dist', 'cli.js');

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

console.log('[verify] render capture stall budget');

const main = fs.readFileSync(MAIN_PATH, 'utf8');

// --- the upstream contract the fix rides on ---------------------------------
if (!fs.existsSync(CLI_PATH)) {
    console.log('  skip hyperframes not installed; cannot verify the CLI contract');
} else {
    const cli = fs.readFileSync(CLI_PATH, 'utf8');

    check(
        'the CLI still honours HF_DE_STALL_MS',
        cli.includes('HF_DE_STALL_MS'),
        'the env override main.js sets is gone upstream -- the budget is now a '
        + 'silent no-op and heavy renders will demote themselves again'
    );

    check(
        'the CLI stall watchdog still counts from before frame progress',
        /lastProgressAt\s*=\s*Date\.now\(\)/.test(cli)
            && cli.includes('no frame progress for'),
        'the watchdog changed shape upstream; re-read whether page setup is '
        + 'still charged against the frame-progress clock'
    );

    // The whole point of overriding is that the shipped default is shorter than
    // real page setup. If upstream raises it past our floor, this fix is no
    // longer load-bearing and should be re-reviewed rather than left in place.
    const defaultMatch = /DEFAULT_DE_STALL_MS\s*=\s*([0-9.e+]+)/.exec(cli);
    check(
        'the CLI default is still shorter than heavy-project page setup',
        defaultMatch && Number(defaultMatch[1]) < 180000,
        `CLI default is ${defaultMatch ? Number(defaultMatch[1]) : '(not found)'}ms`
    );

    check(
        'the stall message main.js matches on still exists',
        /capture stalled: no frame progress/i.test(cli),
        'main.js detects a stall by this text to decide whether to keep the GPU; '
        + 'if the wording changed, every stall now silently drops to 1-worker software'
    );
}

// --- app-side wiring --------------------------------------------------------
check(
    'main.js passes a capture stall budget to the render CLI',
    /HF_DE_STALL_MS:\s*String\(stallBudgetMs\)/.test(main),
    'runHyperframesCli no longer sets HF_DE_STALL_MS in the child env'
);

check(
    'the budget is derived from the project, not hardcoded at the call site',
    main.includes('resolveCaptureStallBudgetMs(projectDir)'),
    'the budget is no longer computed from the project being rendered'
);

check(
    'an explicit operator override wins over the computed budget',
    /Number\(process\.env\.HF_DE_STALL_MS\)\s*>\s*0/.test(main),
    'a pinned HF_DE_STALL_MS is being overwritten by the computed value'
);

check(
    'a stall keeps the GPU and steps parallelism down first',
    /rendered\.stalled[^\n]*workers\)\s*>\s*2/.test(main)
        && /Retrying with less parallelism/.test(main),
    'a capture stall drops straight to the 1-worker software tier again -- that '
    + 'is the regression this check exists to prevent'
);

check(
    'the stall verdict is actually reported by the CLI wrapper',
    main.includes('sawCaptureStall') && /stalled:\s*sawCaptureStall\(\)/.test(main),
    'runHyperframesCli no longer tells the caller a failure was a stall, so the '
    + 'GPU-preserving retry can never trigger'
);

// --- the real function, executed --------------------------------------------
// Extract and run main.js's own implementation rather than restating the maths
// here; a copy would drift and start passing while the app regressed.
const fnStart = main.indexOf('function resolveCaptureStallBudgetMs(');
const fnEnd = fnStart >= 0 ? main.indexOf('\n}\n', fnStart) : -1;
if (fnStart < 0 || fnEnd < 0) {
    check('resolveCaptureStallBudgetMs is present in main.js', false,
        'the budget function was removed or renamed');
} else {
    const src = main.slice(fnStart, fnEnd + 2);
    // eslint-disable-next-line no-new-func
    const resolveCaptureStallBudgetMs = new Function('fs', 'path',
        `${src}\nreturn resolveCaptureStallBudgetMs;`)(fs, path);

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yta-stall-'));
    const makeProject = (name, mediaCount) => {
        const dir = path.join(tmpRoot, name);
        fs.mkdirSync(path.join(dir, 'media'), { recursive: true });
        for (let i = 0; i < mediaCount; i++) {
            fs.writeFileSync(path.join(dir, 'media', `clip-${i}.mp4`), '');
        }
        return dir;
    };

    try {
        check(
            'a project with no media dir still gets more than the CLI default',
            resolveCaptureStallBudgetMs(path.join(tmpRoot, 'does-not-exist')) >= 180000,
            'the floor no longer clears the 60s default this fix exists to raise'
        );

        // The exact shape that failed on 2026-07-31. The slowest worker was
        // ready at 82s; the budget must clear that with real headroom, because
        // a slower disk or bigger clips push setup further out.
        const real = resolveCaptureStallBudgetMs(makeProject('real', 122));
        check(
            'the render that actually failed would now survive setup',
            real >= 300000,
            `122 media -> ${Math.round(real / 1000)}s; the measured setup was 82s`
        );

        const light = resolveCaptureStallBudgetMs(makeProject('light', 8));
        const heavy = resolveCaptureStallBudgetMs(makeProject('heavy', 200));
        check(
            'the budget grows with the project instead of being one flat number',
            heavy > light,
            `8 media -> ${light}ms, 200 media -> ${heavy}ms`
        );

        check(
            'a hung capture is still bounded so the fallback tiers can take over',
            resolveCaptureStallBudgetMs(makeProject('huge', 400)) <= 600000,
            'the budget is unbounded; a genuinely hung render would never fall back'
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
}

console.log(`\n[verify] render capture stall budget: ${checks - failures}/${checks} passed`);
if (failures > 0) {
    console.error(`[verify] FAILED (${failures})`);
    process.exit(1);
}
