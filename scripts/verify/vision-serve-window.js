#!/usr/bin/env node
/**
 * Gate for lightning/serve-vision.sh — the script that brings vLLM up on the
 * rented GPU. Every failure this guards against is SILENT: the box boots, the
 * app reports "vision ready", and every image is rejected or scored by a server
 * that is quietly the wrong shape. Nothing in the app notices.
 *
 * Three real incidents are pinned here, all measured on 2026-07-31:
 *
 *  1. A vLLM already running at a 4096-token window was kept forever, because
 *     the guard only asked "is a vLLM running?". Presence is not health. Proven
 *     live: the old script printed "vLLM already running" / "launched" against a
 *     4096 server and the app then rejected every scoring request.
 *  2. A rung that had been SERVING for 502s was treated as "failed to start"
 *     because 502 < the 600s wall-clock grace, and the ladder shrank the window
 *     under it. Elapsed time cannot tell a crash from a refusal; "did it ever
 *     answer?" can.
 *  3. The ladder from a previous launch survives in the background. Killing
 *     vLLM without retiring it first made it race the new launch: two vLLMs on
 *     one card, "exited (code 137) at window 8192", then code 1 at 4096, GPU at
 *     0 MiB and no vision at all.
 *
 * The script is EXECUTED here against stub `pgrep`/`curl`/`vllm`/... rather than
 * pattern-matched, because a restated copy of the logic would keep passing while
 * the deployed script drifted. src/lightning-control.py base64-pushes this exact
 * file to the studio on every start, so the file under test IS the deployment.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SERVE = path.join(ROOT, 'lightning', 'serve-vision.sh');

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
    if (ok) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`); }
}

console.log('[vision-serve-window] the GPU must never come up quietly wrong\n');

if (!fs.existsSync(SERVE)) {
    console.log(`  FAIL lightning/serve-vision.sh is missing at ${SERVE}`);
    process.exit(1);
}
const src = fs.readFileSync(SERVE, 'utf8');

// ── static anchors: the pieces that cannot be exercised off a real box ───────
console.log('[1] the shape of the script');

check('it still parses as shell',
    (() => { try { execFileSync('bash', ['-n', SERVE], { stdio: 'pipe' }); return true; } catch (_) { return false; } })(),
    'bash -n rejected the script — it would fail on the studio, not here');

check('the serviceable floor is defined and at least 8192',
    /WINDOW_FLOOR="\$\{WINDOW_FLOOR:-(\d+)\}"/.test(src)
    && Number(src.match(/WINDOW_FLOOR="\$\{WINDOW_FLOOR:-(\d+)\}"/)[1]) >= 8192,
    'real scoring requests measured 3694-5149 tokens; a floor at or below 4096 '
    + 'would accept a server that rejects them');

check('the ladder still starts at the widest window',
    /CONTEXT_LADDER="\$\{CONTEXT_LADDER:-\$MAX_MODEL_LEN /.test(src),
    'the ladder must try the widest rung first and step DOWN');

check('a running server is asked what window it serves',
    /\/v1\/models/.test(src) && /max_model_len/.test(src),
    'without reading the served window the guard is back to "is something running?"');

check('there is a cmdline fallback for a server that is still loading',
    /\/proc\/\$pid\/cmdline/.test(src) && /--max-model-len/.test(src),
    '/v1/models is silent while the model loads; the process arguments answer then');

check('a rung that failed to start is recorded against this GPU',
    /note_rejected "\$len"/.test(src) && /nvidia-smi --query-gpu=name/.test(src),
    'without a per-GPU ledger, a card that genuinely cannot hold 8192 would be '
    + 'restarted on every single app start');

// ── behavioural: run the real script against stubs ──────────────────────────
console.log('\n[2] what the script actually does');

// The behavioural half executes the script, so it needs a shell. Say so out
// loud rather than reporting a green run that only checked the static anchors.
let haveBash = true;
try { execFileSync('bash', ['-c', 'exit 0'], { stdio: 'ignore' }); } catch (_) { haveBash = false; }
if (!haveBash) {
    console.log('  SKIP no bash on PATH — only the static anchors above were checked.');
    console.log('       Run this from Git Bash to exercise the script itself.');
    console.log(`\n[vision-serve-window] ${pass}/${pass + fail} passed (static only)`);
    process.exit(fail ? 1 : 0);
}

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'yta-serve-'));
const BIN = path.join(SANDBOX, 'stub');
const VENV = path.join(SANDBOX, 'venv', 'bin');
fs.mkdirSync(BIN, { recursive: true });
fs.mkdirSync(VENV, { recursive: true });

/** Block the main thread — the ladder is a background process, not a promise. */
function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function writeStub(dir, name, body) {
    const p = path.join(dir, name);
    fs.writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`);
    fs.chmodSync(p, 0o755);
}

// pgrep: STUB_VLLM_PID / STUB_LADDER_PIDS drive what is "running". Once pkill
// has been called the stub server is gone, so the script's wait-for-exit loop
// finishes the way it would on a real box.
writeStub(BIN, 'pgrep', `
want="\${@: -1}"
case "$want" in
  *"vllm serve"*)
    [ -f "$SANDBOX_STATE/vllm_killed" ] && exit 1
    [ -n "\${STUB_VLLM_PID:-}" ] && echo "\${STUB_VLLM_PID}" && exit 0
    exit 1 ;;
  *serve-vision*)
    [ -n "\${STUB_LADDER_PIDS:-}" ] && { for p in \${STUB_LADDER_PIDS}; do echo "$p"; done; exit 0; }
    exit 1 ;;
esac
exit 1`);

// pkill: record the request, and retire the stub server.
writeStub(BIN, 'pkill', `
echo "pkill $@" >> "$STUB_LOG"
case "$*" in *"vllm serve"*) : > "$SANDBOX_STATE/vllm_killed" ;; esac
exit 0`);

// curl: serves STUB_WINDOW only when STUB_SERVING=1.
writeStub(BIN, 'curl', `
if [ "\${STUB_SERVING:-0}" = "1" ]; then
  echo "{\\"object\\":\\"list\\",\\"data\\":[{\\"id\\":\\"qwen2.5-vl\\",\\"max_model_len\\":\${STUB_WINDOW:-16384}}]}"
  exit 0
fi
exit 7`);

writeStub(BIN, 'nvidia-smi', `
for a in "$@"; do case "$a" in *memory.used*) echo 0; exit 0 ;; esac; done
echo "Tesla T4"
exit 0`);

writeStub(BIN, 'nohup', 'exec "$@"');
writeStub(VENV, 'python', 'exit 0');

// vllm: records the arguments it was launched with, then exits after
// STUB_VLLM_EXIT_AFTER seconds so the ladder can be driven quickly.
writeStub(VENV, 'vllm', `
echo "$@" >> "$STUB_LOG.vllm"
sleep "\${STUB_VLLM_EXIT_AFTER:-1}"
exit "\${STUB_VLLM_EXIT_CODE:-1}"`);

writeStub(SANDBOX, 'cloudflared', 'sleep 30');

/**
 * How expensive is ONE process spawn on this machine, right now?
 *
 * Everything the scenarios below wait for is a background ladder of shell
 * processes, so the only thing that makes a scenario slow is the price of a
 * spawn — and that price is not a property of the code, it is a property of
 * how busy the machine is when the gate runs. Idle it is single-digit ms;
 * with every core pegged it was measured at ~425ms, an 80x swing.
 *
 * So the budget is not a constant. It is measured here and multiplied by the
 * number of spawns the ladder actually costs. That is the whole §3.8 lesson
 * applied properly: a bound belongs in the unit of the thing that varies.
 * A constant is only ever right for the machine it was written on.
 */
let _spawnCostMs = null;
function spawnCostMs() {
    if (_spawnCostMs !== null) return _spawnCostMs;
    const N = 5;
    const t0 = Date.now();
    for (let i = 0; i < N; i++) {
        // a failed spawn is still a spawn, and a spawn is what is being timed
        try { execFileSync('bash', ['-c', 'exit 0'], { stdio: 'ignore', timeout: 60000 }); } catch (_) { /* noop */ }
    }
    _spawnCostMs = Math.max(1, Math.round((Date.now() - t0) / N));
    return _spawnCostMs;
}

// The ladder is three rungs, each rung is ~8 spawns, and the watcher subshell
// polls on top of that. Measured idle: a spawn costs ~227ms here and the
// step-down scenario needs ~20s, i.e. about 90 spawns. 300 is that with a
// wide margin — and the margin is FREE, because a positive wait breaks the
// instant its event lands. A generous budget is only ever spent on a run that
// was going to fail anyway.
const LADDER_SPAWNS = 300;

/**
 * Run the real serve script with a given stub world. Returns its stdout + logs.
 * `until` is polled against the collected state so a scenario costs what it
 * needs rather than a flat sleep — this gate runs on every commit.
 *
 * `waitMs` is a STALL budget, not a total one: how long the ladder may go
 * without writing anything new before we call it stuck. See the note on the
 * poll loop below for why it is not a wall clock.
 */
function run(env, { waitMs = 2000, until = null } = {}) {
    const stateDir = fs.mkdtempSync(path.join(SANDBOX, 'state-'));
    const stubLog = path.join(stateDir, 'stub.log');
    fs.writeFileSync(stubLog, '');
    const home = fs.mkdtempSync(path.join(SANDBOX, 'home-'));
    // the script prepends $HOME/venv/bin to PATH, so mirror the venv into it
    fs.mkdirSync(path.join(home, 'venv'), { recursive: true });
    fs.symlinkSync(VENV, path.join(home, 'venv', 'bin'), 'junction');

    let stdout = '';
    try {
        stdout = execFileSync('bash', [SERVE], {
            encoding: 'utf8',
            // A net against a hung script, NOT a performance budget. The script
            // does ~5-10s of real work here, so 60s looked like a 6-10x margin —
            // but when it is exceeded the script is KILLED, which empties the
            // stdout three assertions below read and orphans the background
            // ladder the rest of them wait on. One slow machine then reports
            // four unrelated failures that say nothing about the script.
            // Measured with all 12 cores pegged: the script needs well past 60s,
            // so the net was catching healthy runs. Raised to the same ceiling
            // the poll uses, for the same reason — it bounds a hang and nothing
            // else, and no healthy run should ever come near it.
            timeout: 180000,
            env: {
                PATH: `${BIN}${path.delimiter}${process.env.PATH}`,
                HOME: home,
                SANDBOX_STATE: stateDir,
                STUB_LOG: stubLog,
                CLOUDFLARED_BIN: path.join(SANDBOX, 'cloudflared'),
                BOOT_GRACE: '99999',
                ...env,
            },
        });
    } catch (e) {
        stdout = `${e.stdout || ''}${e.stderr || ''}`;
    }
    // the ladder runs in the background after the script returns; let it write
    const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');
    const collect = () => ({
        stdout,
        launched: read(`${stubLog}.vllm`),
        serveLog: read(path.join(home, 'vision-serve.log')),
        rejected: read(path.join(home, '.vision-window-rejected')),
        home,
    });
    // ── Bounded by PROGRESS, not by the clock ─────────────────────────────
    //
    // Everything this waits on is a background ladder made of shell processes,
    // and on Windows a process spawn costs a few ms on an idle machine and up
    // to ~425ms with every core busy. Measured on this repo: the step-down
    // scenario needs 14-20s idle — the script's own log reports 3s per rung for
    // a stub that exits instantly, because a rung is ~8 spawns. A flat 30s
    // budget therefore left a 1.5x margin, and duly passed when run alone and
    // failed inside the full gate. That is the THIRD time in this work that a
    // wall-clock limit sized against an idle machine changed behaviour on a
    // busy one (see docs/anti-ai-look-baseline.md §3.8).
    //
    // A bigger constant would only move the failure, so this is not one. The
    // budget is now a STALL budget: any change in what the ladder has written
    // resets it. A slow machine takes longer and still passes; a genuinely
    // stuck ladder writes nothing and still fails in waitMs, which is the thing
    // the bound was always trying to express. The ladder is finite (three rungs
    // then it stops), so the stall always arrives.
    //
    // A stall budget alone is not enough, though, and the saturation run proved
    // it: a stall budget only helps when there are INTERMEDIATE events to reset
    // it. In the two scenarios that wait for the launch line, the event being
    // waited on is the FIRST event, so there is nothing to reset against and
    // the budget degenerates back into the wall clock it was meant to replace.
    // Hence `waitMs` is only a FLOOR. The real budget is the measured price of
    // a spawn on this machine times the number of spawns the ladder costs, so
    // a busy machine gets a proportionally longer budget without anyone
    // guessing a number.
    //
    // Scaling applies ONLY to a positive wait (`until` is set: "keep looking
    // until this appears"). A scenario with no predicate is asserting that
    // NOTHING happens, so its budget is dead time by definition and stretching
    // it proves nothing while multiplying the gate's runtime — inflating those
    // too is what made this script hang for five minutes instead of finishing
    // in thirty seconds.
    //
    // The ceiling exists only so a pathological loop cannot hang the commit
    // gate forever. It is not a tuning knob and no scenario should ever reach
    // it.
    const CEILING_MS = 180000;
    const budgetMs = until
        ? Math.min(CEILING_MS, Math.max(waitMs, spawnCostMs() * LADDER_SPAWNS))
        : waitMs;
    const signature = (s) => `${s.launched.length}|${s.serveLog.length}|${s.rejected.length}`;
    const hardStop = Date.now() + CEILING_MS;
    let state = collect();
    let sig = signature(state);
    let stallDeadline = Date.now() + budgetMs;
    while (Date.now() < stallDeadline && Date.now() < hardStop) {
        if (until ? until(state) : state.launched) break;
        sleepSync(200);
        state = collect();
        const next = signature(state);
        if (next !== sig) { sig = next; stallDeadline = Date.now() + budgetMs; }
    }
    return state;
}

// --- nothing running -> start at the widest window --------------------------
// `until` names the thing this block actually asserts, rather than "any launch
// line has appeared". Both scenarios below wait on the real ladder starting a
// background process, so the honest bound is generous — but the poll breaks the
// instant the predicate holds, so on an idle machine it still costs milliseconds
// and only a genuine failure pays the full wait. Waiting a flat 2s instead is
// what made this block fail inside the full gate and pass on its own.
const LAUNCHED_WIDE = (s) => /--max-model-len 16384/.test(s.launched);
{
    const r = run(
        { STUB_VLLM_EXIT_AFTER: '0', STUB_VLLM_EXIT_CODE: '0' },
        { waitMs: 15000, until: LAUNCHED_WIDE }
    );
    check('with no server running it launches one',
        /starting vLLM/.test(r.stdout), r.stdout.slice(0, 300));
    check('the launch asks for the 16384-token window',
        /--max-model-len 16384/.test(r.launched),
        `vllm was launched with: ${r.launched.trim().slice(0, 200) || '(nothing)'}`);
}

// --- a server at 4096 is REPLACED (incident 1) ------------------------------
{
    const r = run({
        STUB_VLLM_PID: '4242', STUB_SERVING: '1', STUB_WINDOW: '4096',
        STUB_VLLM_EXIT_AFTER: '0', STUB_VLLM_EXIT_CODE: '0',
    }, { waitMs: 15000, until: LAUNCHED_WIDE });
    check('a server serving 4096 is replaced, not accepted',
        /under the 8192-token floor — replacing it/.test(r.stdout), r.stdout.slice(0, 400));
    check('the replacement is launched at the wide window',
        /--max-model-len 16384/.test(r.launched),
        `vllm was launched with: ${r.launched.trim().slice(0, 200) || '(nothing — it was never restarted)'}`);
}

// --- a healthy server is LEFT ALONE (this runs on every app start) ----------
{
    const r = run({ STUB_VLLM_PID: '4242', STUB_SERVING: '1', STUB_WINDOW: '16384' });
    check('a server already serving 16384 is left alone',
        /already running with a 16384-token reading window/.test(r.stdout), r.stdout.slice(0, 400));
    check('a healthy server is not restarted',
        r.launched.trim() === '',
        `it relaunched vllm anyway: ${r.launched.trim().slice(0, 200)} — this script runs on `
        + 'every app start, so churning here would cost a 3-minute reboot each time');
}

// --- a GPU that has genuinely refused a wide window is respected ------------
{
    const seed = (home) => fs.writeFileSync(path.join(home, '.vision-window-rejected'), 'Tesla-T4 16384\nTesla-T4 8192\n');
    // seed before the run by pre-creating HOME content: easiest is a wrapper run
    const stateHome = fs.mkdtempSync(path.join(SANDBOX, 'preseed-'));
    fs.mkdirSync(path.join(stateHome, 'venv'), { recursive: true });
    fs.symlinkSync(VENV, path.join(stateHome, 'venv', 'bin'), 'junction');
    seed(stateHome);
    const stubLog = path.join(stateHome, 'stub.log');
    let stdout = '';
    try {
        stdout = execFileSync('bash', [SERVE], {
            encoding: 'utf8', timeout: 180000,   // a hang net, not a budget — see run() above
            env: {
                PATH: `${BIN}${path.delimiter}${process.env.PATH}`,
                HOME: stateHome, SANDBOX_STATE: stateHome, STUB_LOG: stubLog,
                CLOUDFLARED_BIN: path.join(SANDBOX, 'cloudflared'), BOOT_GRACE: '99999',
                STUB_VLLM_PID: '4242', STUB_SERVING: '1', STUB_WINDOW: '4096',
            },
        });
    } catch (e) { stdout = `${e.stdout || ''}${e.stderr || ''}`; }
    check('a card that already refused a wide window is not restarted forever',
        /restarting would only churn/.test(stdout), stdout.slice(0, 400));

    let forced = '';
    try {
        forced = execFileSync('bash', [SERVE], {
            encoding: 'utf8', timeout: 180000,   // a hang net, not a budget — see run() above
            env: {
                PATH: `${BIN}${path.delimiter}${process.env.PATH}`,
                HOME: stateHome, SANDBOX_STATE: stateHome, STUB_LOG: `${stubLog}2`,
                CLOUDFLARED_BIN: path.join(SANDBOX, 'cloudflared'), BOOT_GRACE: '99999',
                STUB_VLLM_PID: '4242', STUB_SERVING: '1', STUB_WINDOW: '4096',
                VISION_WINDOW_FORCE: '1',
            },
        });
    } catch (e) { forced = `${e.stdout || ''}${e.stderr || ''}`; }
    check('VISION_WINDOW_FORCE overrides that ledger',
        /replacing it/.test(forced), forced.slice(0, 400));
}

// --- an unreadable window is not guessed at --------------------------------
{
    const r = run({ STUB_VLLM_PID: '4242', STUB_SERVING: '0' });
    check('a server whose window cannot be read is left alone, not killed',
        /reading window unreadable — leaving it alone/.test(r.stdout), r.stdout.slice(0, 400));
    check('an unreadable server is not restarted on a guess',
        r.launched.trim() === '',
        'killing a server we cannot measure would turn an unknown into an outage');
}

// --- incident 2: a rung that SERVED must not be shrunk ----------------------
{
    // vllm answers (STUB_SERVING=1) then dies. The ladder must stop, not step down.
    const r = run({
        STUB_SERVING: '1', STUB_WINDOW: '16384',
        STUB_VLLM_EXIT_AFTER: '2', STUB_VLLM_EXIT_CODE: '1',
        BOOT_GRACE: '99999',
        // The predicate is an OR of both possible outcomes, so this stops the
        // moment the question is settled either way — the good message or the
        // step-down that would mean the bug is back. The bound only has to be
        // longer than the slowest machine takes to decide, so it is generous.
    }, { waitMs: 30000, until: (s) => /had already served requests|reading window 8192/.test(s.serveLog) });
    check('a window that served real traffic is never shrunk when it later dies',
        /had already served requests/.test(r.serveLog),
        `ladder log:\n${r.serveLog.slice(0, 600)}`);
    check('it does not fall to a smaller rung after serving',
        !/reading window 8192/.test(r.serveLog),
        'it stepped down from a window that was demonstrably working — that is the '
        + 'original silent-shrink bug wearing a different hat');
    check('a proven window is not blamed on the GPU in the ledger',
        !/16384/.test(r.rejected),
        `ledger says: ${r.rejected.trim()}`);
}

// --- the ladder still steps down when a rung genuinely cannot start ---------
{
    const r = run({
        STUB_SERVING: '0',
        STUB_VLLM_EXIT_AFTER: '0', STUB_VLLM_EXIT_CODE: '1',
        BOOT_GRACE: '99999',
        // Wait on the LEDGER, which is what the second check below actually
        // reads. Waiting on the log line for the next rung was close but not
        // the same event, and the gap between them is where this block failed
        // under load: the log had moved on, the ledger write had not landed.
    }, {
        waitMs: 30000,
        until: (s) => /16384/.test(s.rejected) && /8192/.test(s.rejected),
    });
    check('a rung that never serves does step down',
        /reading window 16384/.test(r.serveLog) && /reading window 8192/.test(r.serveLog),
        `ladder log:\n${r.serveLog.slice(0, 600)}`);
    check('the refused rungs are written to the per-GPU ledger',
        /16384/.test(r.rejected) && /8192/.test(r.rejected),
        `ledger says: ${r.rejected.trim() || '(empty)'}`);
}

// --- incident 3: a leftover ladder is retired before vLLM is touched --------
{
    // A REAL process stands in for the stale supervisor, so "it was killed" is a
    // fact about the process table rather than a message we printed. It reports
    // its own pid and ticks a heartbeat file: both the pid the script kills and
    // the evidence that it died stay inside one process namespace, which matters
    // because the serve script's `kill` and this runner do not share one on
    // Windows.
    const stateHome = fs.mkdtempSync(path.join(SANDBOX, 'stale-'));
    fs.mkdirSync(path.join(stateHome, 'venv'), { recursive: true });
    fs.symlinkSync(VENV, path.join(stateHome, 'venv', 'bin'), 'junction');
    const pidFile = path.join(stateHome, 'ladder.pid');
    const beatFile = path.join(stateHome, 'ladder.beat');
    const victim = spawn('bash', ['-c',
        `echo $$ > "${pidFile}"; while :; do date +%s%N > "${beatFile}"; sleep 0.2; done`],
    { stdio: 'ignore' });

    // "Did it die?" is answered by "it stopped ticking for a while" — and how
    // long *a while* is was a flat 1.5s guess. That is the same mistake this
    // file has already been caught by twice: a wall-clock number picked on a
    // fast machine, which on a slow one stops measuring what it claims to.
    // So calibrate against the victim's OWN heartbeat instead. Its real
    // interval is a fact we can observe in a second; six of them is then a
    // meaningful silence on any machine, fast or crawling.
    const readBeat = () => (fs.existsSync(beatFile) ? fs.readFileSync(beatFile, 'utf8') : '');
    const waitForBeatChange = (from, budgetMs) => {
        const started = Date.now();
        const deadline = started + budgetMs;
        while (Date.now() < deadline) {
            const now = readBeat();
            if (now && now !== from) return { changed: true, ms: Date.now() - started, value: now };
            sleepSync(25);
        }
        return { changed: false, ms: budgetMs, value: readBeat() };
    };

    const first = waitForBeatChange('', 15000);          // wait for it to come alive
    const second = waitForBeatChange(first.value, 15000); // one observed interval
    const beatIntervalMs = Math.max(first.ms, second.ms, 200);
    const ladderPid = fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8').trim() : '';
    try {
        execFileSync('bash', [SERVE], {
            encoding: 'utf8', timeout: 180000,   // a hang net, not a budget — see run() above
            env: {
                PATH: `${BIN}${path.delimiter}${process.env.PATH}`,
                HOME: stateHome, SANDBOX_STATE: stateHome,
                STUB_LOG: path.join(stateHome, 'stub.log'),
                CLOUDFLARED_BIN: path.join(SANDBOX, 'cloudflared'), BOOT_GRACE: '99999',
                STUB_VLLM_PID: '4242', STUB_SERVING: '1', STUB_WINDOW: '4096',
                STUB_LADDER_PIDS: ladderPid,
                STUB_VLLM_EXIT_AFTER: '0', STUB_VLLM_EXIT_CODE: '0',
            },
        });
    } catch (_) { /* exit code is not the subject here */ }
    const beatBefore = readBeat();
    // Exits early the instant it ticks again, so a genuine failure is fast; a
    // pass costs the calibrated silence and nothing more.
    const after = waitForBeatChange(beatBefore, Math.max(1500, beatIntervalMs * 6));
    const beatAfter = after.changed ? after.value : beatBefore;
    check('a leftover ladder from an earlier launch is retired before vLLM is killed',
        Boolean(ladderPid) && beatBefore !== '' && beatBefore === beatAfter,
        ladderPid
            ? 'the old supervisor is still ticking — it will see our kill, call it a failed '
              + 'startup and launch its own rung against ours: two vLLMs, one card, both dead'
            : 'the stand-in supervisor never reported a pid, so this check proved nothing');
    try { victim.kill('SIGKILL'); } catch (_) { /* already gone */ }
}

try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (_) { /* best effort */ }

console.log(`\n[vision-serve-window] ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
