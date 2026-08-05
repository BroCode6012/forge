#!/usr/bin/env node
/**
 * Patch hyperframes' parallel-capture worker validation.
 *
 * WHY
 * ---
 * `executeParallelCapture()` validates each worker's frame count after the
 * capture finishes. It computes the expectation from the worker RESULT object:
 *
 *     if (!r2.error && r2.framesCaptured < expectedFramesForTask(r2))
 *
 * ...but `expectedFramesForTask()` reads `frameStride ?? 1`, and the result
 * object carries no `frameStride` — only the TASK does. The same function
 * already computes its own `totalFrames` correctly, straight off the tasks:
 *
 *     tasks.reduce((sum, t2) => sum + Math.ceil((t2.endFrame - t2.startFrame) / (t2.frameStride ?? 1)), 0)
 *
 * On the interleaved streaming path (`distributeFramesInterleaved`, which sets
 * `frameStride: workerCount`) each worker captures totalFrames/workerCount
 * frames — correctly — but is measured against the FULL frame count. With
 * N workers every worker is therefore guaranteed to "fail", the run throws
 * `[Parallel] Capture failed`, and a fully-captured video is discarded.
 *
 * The path is arithmetically incapable of succeeding with workerCount > 1,
 * which is very likely why it sits behind force flags and a 240s duration cap.
 *
 * THE FIX
 * -------
 * Measure each result against its own task. `Promise.all(tasks.map(...))`
 * preserves order, so results[i] corresponds to tasks[i].
 *
 * For the default contiguous path (`distributeFrames`, no `frameStride`) this
 * is a no-op: stride is 1 either way and start/end match between task and
 * result. It only ever *corrects* the strided case; it never weakens the check.
 *
 * Idempotent. Safe to run repeatedly. Exits non-zero only if the target file
 * exists but matches neither the original nor the patched shape (i.e. the
 * dependency changed and a human needs to re-check this).
 */

const fs = require('fs');
const path = require('path');

const CLI_PATH = path.join(__dirname, '..', 'node_modules', 'hyperframes', 'dist', 'cli.js');

const ORIGINAL = `  for (const r2 of results) {
    if (!r2.error && r2.framesCaptured < expectedFramesForTask(r2)) {
      r2.error = synthesizeSilentWorkerExitError(r2, expectedFramesForTask(r2));
    }
  }
  const errors = results.filter((r2) => r2.failure || r2.error);`;

const PATCHED = `  for (let ri = 0; ri < results.length; ri++) {
    const r2 = results[ri];
    const expectedForWorker = expectedFramesForTask(tasks[ri] ?? r2);
    if (!r2.error && r2.framesCaptured < expectedForWorker) {
      r2.error = synthesizeSilentWorkerExitError(r2, expectedForWorker);
    }
  }
  const errors = results.filter((r2) => r2.failure || r2.error);`;

function main() {
    if (!fs.existsSync(CLI_PATH)) {
        // Dependencies not installed yet — nothing to do, and not an error.
        console.log('[patch-hyperframes] hyperframes CLI not present; skipping.');
        return 0;
    }

    const source = fs.readFileSync(CLI_PATH, 'utf8');

    if (source.includes(PATCHED)) {
        console.log('[patch-hyperframes] already patched (parallel-stream frame validation).');
        return 0;
    }

    if (!source.includes(ORIGINAL)) {
        console.error('[patch-hyperframes] FAILED: neither the original nor the patched');
        console.error('  snippet was found in node_modules/hyperframes/dist/cli.js.');
        console.error('  The dependency almost certainly changed. Re-verify whether the');
        console.error('  worker frame-count validation still measures results against');
        console.error('  results (bug) or against tasks (fixed), then update this script.');
        return 1;
    }

    const patched = source.replace(ORIGINAL, PATCHED);
    if (patched === source) {
        console.error('[patch-hyperframes] FAILED: replacement produced no change.');
        return 1;
    }

    fs.writeFileSync(CLI_PATH, patched);
    console.log('[patch-hyperframes] applied: parallel-stream frame validation now measures');
    console.log('  each worker against its own task stride (was: against the full frame count).');
    return 0;
}

process.exit(main());
