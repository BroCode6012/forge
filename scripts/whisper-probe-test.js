#!/usr/bin/env node
/**
 * One-off live proof for the transcribe.js interpreter-probe fix (2026-08-04).
 *
 * The bug: the probe ran `python -c "import faster_whisper"` with a 20s timeout.
 * Cold on Windows that import is ~34s (0.1s CPU, the rest is faulting native DLLs
 * off disk), so the probe SIGTERM'd a WORKING interpreter, recorded it as "does not
 * have the package", did the same to the next one, and the build died with
 * "no python interpreter with the required whisper package was found".
 *
 * This script measures both questions side by side on the real machine:
 *   A) find_spec  — "is it installed?"   (what the probe asks now)
 *   B) import     — "can it fully load?" (what the probe used to ask)
 * and then runs a real transcription through the public API to prove the wiring.
 *
 * Not part of `npm run verify` — it needs python, ffmpeg and ~1 minute.
 * The permanent, CI-safe regression gate is scripts/verify/whisper-interpreter.js.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const MODULES = ['faster_whisper', 'whisperx', 'whisper'];
const CANDIDATES = [
    { bin: 'py', args: ['-3.10'] },
    { bin: 'python', args: [] },
    { bin: 'python3', args: [] },
    { bin: 'py', args: ['-3.11'] },
    { bin: 'py', args: ['-3'] },
];
const OLD_TIMEOUT_MS = 20000; // what the shipped code used to allow

function ms(fn) {
    const t0 = Date.now();
    const out = fn();
    return { ms: Date.now() - t0, out };
}

console.log('='.repeat(74));
console.log('A) find_spec  vs  import   — per interpreter, per module');
console.log('='.repeat(74));

let wouldHaveBeenKilled = 0;
let findSpecMax = 0;

for (const mod of MODULES) {
    console.log(`\n── ${mod} ──`);
    for (const c of CANDIDATES) {
        const label = `${c.bin} ${c.args.join(' ')}`.trim();

        const spec = ms(() => spawnSync(c.bin, [...c.args, '-c',
            `import importlib.util as u,sys; sys.exit(0 if u.find_spec('${mod}') is not None else 1)`],
            { stdio: 'ignore', timeout: 45000 }));
        const hasIt = spec.out.status === 0;

        if (!hasIt) {
            console.log(`   ${label.padEnd(12)} find_spec ${String(spec.ms).padStart(6)}ms  → not installed`);
            continue;
        }
        findSpecMax = Math.max(findSpecMax, spec.ms);

        // Only pay for the heavy import where the package actually exists.
        const imp = ms(() => spawnSync(c.bin, [...c.args, '-c', `import ${mod}`],
            { stdio: 'ignore', timeout: 300000 }));
        const impOk = imp.out.status === 0;
        const killed = imp.ms > OLD_TIMEOUT_MS && impOk;
        if (killed) wouldHaveBeenKilled++;

        console.log(`   ${label.padEnd(12)} find_spec ${String(spec.ms).padStart(6)}ms  → INSTALLED   |  ` +
            `import ${String(imp.ms).padStart(6)}ms → ${impOk ? 'loads' : 'FAILS'}` +
            (killed ? `   ⚠️  OLD 20s PROBE WOULD HAVE DISCARDED THIS WORKING INTERPRETER` : ''));
    }
}

console.log('\n' + '='.repeat(74));
console.log(`find_spec worst case: ${findSpecMax}ms  (old probe ceiling was ${OLD_TIMEOUT_MS}ms)`);
console.log(`working interpreters the old probe would have thrown away: ${wouldHaveBeenKilled}`);
console.log('='.repeat(74));

// ── B) real transcription through the public API ────────────────────────────
const src = process.argv[2];
if (!src || !fs.existsSync(src)) {
    console.log('\n(no audio path given — skipping the live transcription leg)');
    process.exit(0);
}

const clip = path.join(os.tmpdir(), `whisper-probe-${process.pid}.wav`);
console.log(`\nTrimming 12s of real narration → ${clip}`);
const ff = spawnSync('ffmpeg', ['-y', '-ss', '00:00:05', '-t', '12', '-i', src,
    '-ac', '1', '-ar', '16000', clip], { stdio: 'ignore', timeout: 120000 });
if (ff.status !== 0 || !fs.existsSync(clip)) {
    console.log('ffmpeg trim failed — skipping the live transcription leg');
    process.exit(0);
}

console.log('Running the REAL transcribeAudio() …\n');
const { transcribeAudio } = require('../src/pipeline/transcribe');
const t0 = Date.now();
transcribeAudio(clip)
    .then((tr) => {
        const words = (tr.segments || []).reduce((n, s) => n + ((s.words || []).length), 0);
        console.log('\n' + '='.repeat(74));
        console.log(`✅ TRANSCRIBED in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        console.log(`   language=${tr.language}  duration=${Number(tr.duration).toFixed(2)}s  ` +
            `segments=${(tr.segments || []).length}  words=${words}`);
        console.log(`   text: ${String(tr.text || '').trim().slice(0, 160)}…`);
        console.log('='.repeat(74));
        if (!words) { console.log('❌ no word timings — the splitter needs these'); process.exit(1); }
        try { fs.unlinkSync(clip); } catch (_) {}
    })
    .catch((e) => {
        console.log(`\n❌ TRANSCRIPTION FAILED: ${e.message}`);
        process.exit(1);
    });
