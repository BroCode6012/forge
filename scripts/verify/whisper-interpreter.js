#!/usr/bin/env node
/**
 * VERIFY: choosing a python interpreter for transcription can never again reject
 * one that works.
 *
 * The failure this pins (2026-08-04 build, log app-2026-08-04T19-19-42):
 *
 *     [19:24:58] Transcribing audio — engine=faster-whisper, model=base
 *     [19:26:24] faster-whisper failed: no python interpreter with the required
 *                whisper package was found
 *     [19:27:44] Build failed: no python interpreter with the required whisper
 *                package was found
 *
 * There was nothing wrong with the machine. `_pythonFor` probed each candidate
 * with `python -c "import <mod>"` under a 20s timeout. Measured on that same box
 * minutes later:
 *
 *     py -3.10   find_spec   5,102ms → INSTALLED  |  import 92,566ms → loads
 *     python     find_spec   ~1,000ms → INSTALLED |  import 34,253ms → loads
 *                                       (of which 0.1s was CPU — the rest is
 *                                       Windows faulting torch/ctranslate2 DLLs
 *                                       off a cold disk)
 *
 * So the probe SIGTERM'd a working interpreter mid-import, recorded "does not
 * have the package", and repeated that for every candidate. 86 seconds of being
 * wrong, then a hard build failure with a message that sent you looking for a
 * missing install that was never missing.
 *
 * Two properties make that impossible now, and both are pinned below:
 *
 *   1. The probe asks whether the module is INSTALLED (importlib.find_spec),
 *      never whether it fully LOADS. find_spec walks sys.path and stops; it
 *      cannot be starved by a cold page cache, so its cost is interpreter
 *      startup and nothing else.
 *   2. Every interpreter that passes is kept, in order, and the real run falls
 *      through to the next one if an import genuinely fails. find_spec is the
 *      weaker claim (a corrupt DLL would still pass it), so the authoritative
 *      test is the actual transcription — with somewhere to go when it fails.
 *
 * This regression is silent and intermittent by nature: warm, that import is
 * ~2s and everything passes. It only bites after a reboot or a long idle gap,
 * which is exactly when it looks like a random flake instead of a bug.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SRC_PATH = path.join(ROOT, 'src', 'pipeline', 'transcribe.js');

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

console.log('[verify] whisper interpreter selection');

const src = fs.readFileSync(SRC_PATH, 'utf8');

// --- the shape of the question being asked ----------------------------------
check(
    'the probe asks whether the module is installed, not whether it loads',
    src.includes('importlib.util') && src.includes('find_spec'),
    'the interpreter probe is back to executing the package. A cold '
    + '`import faster_whisper` measured 92s on this machine; any timeout short '
    + 'enough to be useful will discard working interpreters again'
);

check(
    'the probe never runs a bare heavy import to decide availability',
    !/spawnSync\([^)]*'-c',\s*`import \$\{mod\}`/.test(src),
    'found `python -c "import ${mod}"` used as the availability probe — that is '
    + 'the exact call that killed the 2026-08-04 build'
);

const timeoutMatch = /WHISPER_PROBE_TIMEOUT_MS\s*\|\|\s*(\d+)/.exec(src);
check(
    'the probe ceiling is generous enough to survive a cold interpreter start',
    timeoutMatch && Number(timeoutMatch[1]) >= 30000,
    `probe timeout default is ${timeoutMatch ? timeoutMatch[1] + 'ms' : '(not found)'}; `
    + 'a cold `py -3.10` needed 5.1s just to answer find_spec, and the ceiling '
    + 'exists to escape a wedged interpreter, not to bound normal work'
);

// Read the probe literal itself rather than scanning the file — the prose above
// it legitimately quotes `import "faster_whisper"`-style examples.
const probeMatch = /const probe = `([^`]*)`/.exec(src);
check(
    'the probe one-liner carries no double quotes',
    probeMatch && !probeMatch[1].includes('"'),
    probeMatch
        ? `probe is: ${probeMatch[1]} — a double quote in it crosses Windows argument `
          + 'escaping as a single argv entry and will be mangled'
        : 'could not find the probe literal to inspect'
);

// --- the real functions, executed against a stand-in machine ----------------
// Restating the selection logic here would let this file drift into passing
// while the shipped code regressed, so pull the actual code out and run it.
const sliceStart = src.indexOf('const _pyCache = {};');
const runPyStart = src.indexOf('function _runPy(');
const sliceEnd = runPyStart >= 0 ? src.indexOf('\n}\n', runPyStart) : -1;

if (sliceStart < 0 || sliceEnd < 0) {
    check('the selection functions are extractable', false,
        'could not slice _pythonsFor/_runPy out of transcribe.js');
} else {
    const body = src.slice(sliceStart, sliceEnd + 2);
    const quiet = { log() {}, warn() {}, error() {} };
    const load = (fakeSpawn) =>
        // eslint-disable-next-line no-new-func
        new Function('spawnSync', 'console',
            `${body}\nreturn { _pythonsFor, _runPy };`)(fakeSpawn, quiet);

    const label = (c) => `${c.bin} ${c.args.join(' ')}`.trim();

    // A machine where the FIRST interpreter has the package but takes 92s to
    // prove it by importing — i.e. the exact 2026-08-04 machine.
    {
        const seen = [];
        const { _pythonsFor } = load((bin, args) => {
            const isProbe = args.includes('-c');
            const code = args[args.indexOf('-c') + 1] || '';
            // "heavy" means the whole program is `import <mod>` — executing the
            // package. The find_spec one-liner also starts with `import`, but it
            // imports importlib and then only inspects, so it must not match.
            seen.push({ bin, isProbe, heavy: /^import\s+[\w.]+\s*$/.test(code.trim()) });
            if (!isProbe) return { status: 0 };
            // find_spec succeeds fast on py; every other interpreter lacks it.
            if (bin === 'py') return { status: 0 };
            return { status: 1 };
        });
        const found = _pythonsFor('mod_slow_import');
        check(
            'an interpreter that has the package is kept even when importing it is slow',
            found.length > 0 && found[0].bin === 'py',
            'the interpreter that actually has the package was discarded again'
        );
        check(
            'availability is decided without executing the package',
            seen.every((s) => !s.heavy),
            'a bare `import <mod>` was issued while deciding availability'
        );
    }

    // Every passer is retained, in candidate order — that is what gives the real
    // run somewhere to go when an import genuinely fails.
    {
        let probes = 0;
        const { _pythonsFor } = load((bin) => {
            probes++;
            return { status: bin === 'py' || bin === 'python' ? 0 : 1 };
        });
        const found = _pythonsFor('mod_multi');
        check(
            'a fallback interpreter is kept, not just the first one that passes',
            found.length >= 2,
            `kept ${found.length}; a single-candidate list means one bad DLL ends `
            + 'transcription with no fallback'
        );
        check(
            'probing stops once a spare is in hand',
            probes < 5,
            `probed ${probes} interpreters after already having a fallback; each `
            + 'one costs seconds of pure waiting on a cold machine (measured 27s '
            + 'to probe all five)'
        );
        check(
            'the kept interpreters stay in candidate priority order',
            found.length >= 2 && label(found[0]) === 'py -3.10',
            `first kept was "${found[0] ? label(found[0]) : '(none)'}", expected "py -3.10"`
        );
    }

    // A timeout must never be read as "this interpreter has the package".
    {
        const { _pythonsFor, _runPy } = load(() => ({
            status: null, signal: 'SIGTERM', error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }),
        }));
        const found = _pythonsFor('mod_all_timeout');
        check(
            'a probe that times out is not counted as a working interpreter',
            found.length === 0,
            'a killed probe was recorded as a pass; the run would launch an '
            + 'interpreter that never proved it has the package'
        );
        let msg = '';
        try { _runPy(found, 'x.py'); } catch (e) { msg = e.message; }
        check(
            'with nothing found, the failure still names the missing package clearly',
            /no python interpreter with the required whisper package/.test(msg),
            `error was "${msg}"`
        );
    }

    // The fallback that makes find_spec safe: first interpreter fails to import
    // for real, second one works, transcription still happens.
    {
        let calls = 0;
        const { _pythonsFor, _runPy } = load((bin, args) => {
            if (args.includes('-c')) return { status: bin === 'py' || bin === 'python' ? 0 : 1 };
            calls++;
            return { status: calls === 1 ? 1 : 0 }; // first real run fails, second succeeds
        });
        const found = _pythonsFor('mod_broken_first');
        let threw = null;
        try { _runPy(found, 'script.py'); } catch (e) { threw = e; }
        check(
            'a genuinely broken interpreter falls through to the next one',
            threw === null && calls === 2,
            threw ? `threw "${threw.message}" instead of trying the next interpreter`
                : `ran ${calls} interpreter(s); expected a retry on the second`
        );
    }

    // ...and when they all really are broken, it still fails loudly.
    {
        const { _pythonsFor, _runPy } = load((bin, args) => {
            if (args.includes('-c')) return { status: bin === 'py' ? 0 : 1 };
            return { status: 3 };
        });
        let msg = '';
        try { _runPy(_pythonsFor('mod_all_broken'), 'script.py'); } catch (e) { msg = e.message; }
        check(
            'when every interpreter genuinely fails, the error says so',
            /python exited with 3/.test(msg),
            `error was "${msg}"; a silent success here would produce no transcript`
        );
    }
}

// --- the cheap question stays cheap on this machine -------------------------
// Opportunistic: proves find_spec is not itself paying the import cost. Skipped
// where python is absent so the gate stays runnable in CI.
{
    const t0 = Date.now();
    const r = spawnSync('python', ['-c',
        "import importlib.util as u,sys; sys.exit(0 if u.find_spec('yta_definitely_not_a_module') is not None else 1)"],
        { stdio: 'ignore', timeout: 45000 });
    const elapsed = Date.now() - t0;
    if (r.error && r.error.code === 'ENOENT') {
        console.log('  skip no `python` on PATH; cannot time the live probe');
    } else {
        check(
            'a live find_spec probe answers well inside the ceiling',
            elapsed < 20000,
            `find_spec took ${elapsed}ms on this machine — it is doing more than `
            + 'walking sys.path, which is the cost the fix depends on being small'
        );
    }
}

console.log(`\n[verify] whisper interpreter selection: ${checks - failures}/${checks} passed`);
if (failures > 0) {
    console.error(`[verify] FAILED (${failures})`);
    process.exit(1);
}
