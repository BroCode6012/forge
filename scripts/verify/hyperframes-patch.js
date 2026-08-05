#!/usr/bin/env node
/**
 * VERIFY: the hyperframes parallel-stream capture patch is present, and the
 * app's streaming-encode wiring still matches what the patch makes safe.
 *
 * Background: scripts/patch-hyperframes-streaming.js fixes a validation bug in
 * hyperframes' `executeParallelCapture()` that makes the interleaved streaming
 * capture path fail 100% of the time with more than one worker (each worker is
 * measured against the FULL frame count instead of its own strided share).
 *
 * main.js turns that path ON for multi-worker renders. If a reinstall or a
 * dependency bump silently drops the patch, every multi-worker render would
 * discard a fully-captured video at the finish line. This check makes that
 * loud at verify time instead of 12 minutes into a render.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const CLI_PATH = path.join(ROOT, 'node_modules', 'hyperframes', 'dist', 'cli.js');
const MAIN_PATH = path.join(ROOT, 'main.js');
const PATCHER_PATH = path.join(ROOT, 'scripts', 'patch-hyperframes-streaming.js');
const PKG_PATH = path.join(ROOT, 'package.json');

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

console.log('[verify] hyperframes streaming-encode patch');

// --- the patcher itself -----------------------------------------------------
check('patch script exists', fs.existsSync(PATCHER_PATH));

const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
check(
    'patch script runs on postinstall',
    typeof pkg.scripts?.postinstall === 'string'
        && pkg.scripts.postinstall.includes('patch-hyperframes-streaming'),
    `postinstall is: ${pkg.scripts?.postinstall || '(none)'}`
);

// --- the patched dependency -------------------------------------------------
if (!fs.existsSync(CLI_PATH)) {
    console.log('  skip hyperframes not installed; cannot verify the patched CLI');
} else {
    const cli = fs.readFileSync(CLI_PATH, 'utf8');

    check(
        'worker validation measures results against TASKS (patched)',
        cli.includes('const expectedForWorker = expectedFramesForTask(tasks[ri] ?? r2);'),
        'run: node scripts/patch-hyperframes-streaming.js'
    );

    check(
        'buggy results-against-results validation is gone',
        !cli.includes('if (!r2.error && r2.framesCaptured < expectedFramesForTask(r2))'),
        'the unpatched comparison is still present; run the patch script'
    );

    // The patch is only meaningful while the interleaved distributor still
    // stamps a stride onto its tasks. If that changes upstream, re-review.
    check(
        'interleaved distributor still sets frameStride',
        cli.includes('frameStride: workerCount'),
        'distributeFramesInterleaved no longer stamps a stride; re-review the patch'
    );

    check(
        'expectedFramesForTask still reads frameStride',
        cli.includes('const stride = task.frameStride ?? 1;')
            || cli.includes('task.frameStride ?? 1'),
        'the stride accessor changed upstream; re-review the patch'
    );
}

// --- the app-side wiring ----------------------------------------------------
const main = fs.readFileSync(MAIN_PATH, 'utf8');

check(
    'main.js gates streaming encode on multi-worker renders',
    main.includes('HF_CAPTURE_PARALLEL_STREAM') && main.includes('useStreamingEncode'),
    'runHyperframesCli no longer wires the streaming path'
);

check(
    'streaming encode has a kill switch',
    main.includes('HF_STREAMING_ENCODE'),
    'the HF_STREAMING_ENCODE=0 escape hatch is missing'
);

check(
    'streaming encode stays off for single-worker fallback renders',
    /useStreamingEncode\s*=\s*[^;]*workerCount\s*>\s*1/.test(main),
    'the workerCount > 1 guard is missing; the 1-worker software fallback tier '
    + 'must not take the interleaved path'
);

console.log(`\n[verify] hyperframes streaming-encode patch: ${checks - failures}/${checks} passed`);
if (failures > 0) {
    console.error(`[verify] FAILED (${failures})`);
    process.exit(1);
}
