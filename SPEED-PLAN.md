# Build Speed Plan — target 10-20× faster

**Living document.** Each stage has a RESULT block that gets filled in after the test runs,
and a DECISION that can redirect the next stage. If a result contradicts the hypothesis,
update the plan rather than pushing on with it.

Owner: Claude Code sessions on `reorg/professionalization`.
Last updated: 2026-08-31.

---

## The goal

Make a full build 10-20× faster. Cost is explicitly **not** a constraint during testing —
the model can be scaled up for a run and deleted afterwards. Quality must not regress:
`unjudged` stays at 0 and placeholder count must not rise.

---

## Measured baseline (2026-08-30/31, benchmark project, 345 scenes)

Two configurations measured on the same audio:

| | 1 instance, concurrency 4 | 4 instances, concurrency 8 |
|---|---|---|
| winners / 10 min | 4-5 | 12-27 (avg ~16) |
| vision @ 40 concurrent | ~24 s/call | 1.1 s/call |
| unjudged | 18 | **0** |
| YouTube 403 | 355 | 0 |
| provider throttling | — | 3 events in 2 h |

### Where the time actually goes (4 instances, concurrency 8)

```
vision   3.03 h model time ÷ 4 instances   ≈ 45 min
text     1.29 h model time                 ≈ 20 min
────────────────────────────────────────────────────
model subtotal                             ≈ 65 min
ACTUAL active wall clock                   = 152 min
non-model (download, ffmpeg, search, wait) ≈ 87 min
```

**The model is only ~40% of the build.** Infinite GPU alone caps out around 1.5 h.

### Per-scene cost

345 scenes / 152 min at concurrency 8 → **~212 s of work per scene**
(search + download + ffmpeg + 2 agent calls + ~18 vision calls).

Projection, assuming per-scene cost stays flat:

| concurrency | projected wall | instances needed so vision is not the new floor |
|---|---|---|
| 8 | 2.5 h | 4 |
| 16 | 1.3 h | 4-6 |
| 32 | 38 min | ~8 |
| 64 | 19 min | ~16 |

---

## Known constraints

1. **Hard cap** — `footage-manager.js:191` `Math.max(1, Math.min(8, ...))`. Concurrency
   cannot exceed 8 without a code change.
2. **Serial Visual Planner** — `_planVisualsChunked` runs 35 chunks in a `for` loop,
   ~14 min. It is serial **by design**: `usedKeywords` is threaded across chunks so
   footage does not repeat. Parallelising needs a different de-dup strategy.
3. **Providers** — Pexels / Pixabay / YouTube. Only 3 throttle events in 2 h at
   concurrency 8, so there is headroom, but 32 is 4× that rate. Untested.
4. **Local disk + bandwidth** — 32 concurrent video downloads plus ffmpeg processes.
5. **Interruptions** — the laptop has died 3 nights running. Resume now preserves
   everything (see [[project_resume_media_promotion]]), but scaled instances bill through
   any outage.

---

## Stages

### Stage 1 — concurrency 16 (4 instances)  ⬜ NOT STARTED

**Hypothesis**: ~1.3 h wall, providers hold, unjudged stays 0.
**Method**: raise the cap to 32, set `MEDIA_SCENE_CONCURRENCY=16`, resume the benchmark
project. Measure winners/10 min on *fresh* scenes only — the tail of this video is
abstract content that finds nothing and will drag any average down.
**Kill criteria**: >25 throttle events, unjudged >5, or disk/bandwidth saturation.

```
RESULT:   (pending)
DECISION: (pending)
```

### Stage 2 — concurrency 32 (8 instances)  🔴 CRASHED

**Hypothesis**: ~38 min wall. Vision needs ~8 instances to keep up.
**Method**: scale deployment to 8, `MEDIA_SCENE_CONCURRENCY=32`.
**Kill criteria**: as above, plus watch for ffmpeg contention and local memory.

```
RESULT (2026-08-31):
  Ran cold at concurrency 32 / 8 instances. CRASHED after 20 min at scene 47/366 with
  exit 3221225477 (0xC0000005 ACCESS_VIOLATION) — a native crash, no exception, nothing
  to catch. 14 winners, 0 unjudged up to that point.

  Confirmed working before the crash:
    - 8 instances real: 120 concurrent calls -> 120/120 in 1.4s
    - wave planner live: "Splitting 376 scenes into 38 batches" then
      "Planning 38 batches 4 at a time" — 38 serial calls became 10 waves

  Cause hunt. Each RULED OUT by direct test, not reasoning:
    - @napi-rs/canvas concurrency : survived 256 concurrent on real build images
    - the exact file it died on   : scene-39.race-2 decodes fine, 2880x1620
    - bad/unsafe images in temp   : 0 of 81 flagged by isCanvasSafeImage
    - memory starvation           : 31.7GB total, 17GB free, 12 cpus
    - concurrent ffmpeg spawning  : survived 128 concurrent
    - Windows event log           : no node.exe fault recorded

  STILL UNEXPLAINED. No single component reproduces it, which points at an INTERACTION
  under full load rather than one bad call. Every remaining hypothesis costs a ~20 min
  build to test.

  Known-good ladder: concurrency 8 ran for hours; 16 ran ~40 min clean; 32 died in 20 min.

DECISION: fall back to 16 — the fastest level actually observed stable — rather than
  spend hours bisecting a segfault that takes 20 min per attempt. Revisit 32 only if 16
  proves insufficient. One fix shipped regardless: icon-director.js loaded canvas images
  with no isCanvasSafeImage guard, unlike every other call site. Closed, because an
  unguarded native decode can kill an entire build.
```

### Stage 3 — parallelise the Visual Planner  ✅ DONE

```
RESULT (2026-08-31): shipped and confirmed live in a real build.
  _planVisualsChunked now runs chunks in WAVES instead of a serial for-loop. The loop
  body is UNCHANGED — `allEnriched` and `usedKeywords` are shadowed per chunk, so reads
  see the wave's snapshot and writes land locally, then the driver merges. That avoided
  rewriting 100 lines of nested error handling.

  Log evidence: "Splitting 376 scenes into 38 batches" -> "Planning 38 batches 4 at a
  time". 38 serial calls became 10 waves.

  De-dup is preserved at coarser grain: each chunk sees keywords from all EARLIER waves;
  only its 3 wave-mates are invisible to it. VP_PARALLEL_CHUNKS=1 restores the exact old
  behaviour.

QUALITY VERIFIED (2026-09-01, first completed wave-parallel build):

  keyword duplication : 1.23%  (322 distinct of 326)   vs 0.30% serial baseline
  repeated terms      : 4      vs 1 serial
      2x person throwing honey jar
      2x bacteria unable grow soy sauce
      2x freeze-dried coffee jars
      2x documentary concept background   ← generic filler, repeats regardless of waves

  So 3 real topical repeats against the baseline's 1. Above the ~1% line the plan set,
  but read the absolute number, not the percentage: the line was drawn before anyone knew
  what a repeat would cost. Reverting to VP_PARALLEL_CHUNKS=1 trades ~9 min of wall clock
  (planner-large: 134 calls, 20.2 min of model time, compressed ~4x by the waves) for
  three duplicate search strings — and a duplicate STRING is not duplicate FOOTAGE, since
  `pickUnused()` dedups at the provider level underneath it.

DECISION: keep WAVE=4. Revisit only if a build shows visible repeated shots traceable to
  wave-mate collisions. If it ever needs tightening, WAVE=2 halves the invisible window
  and keeps most of the speedup — going straight back to 1 is the wrong first step.

  Scale note: at 374 scenes this is 38 batches / 10 waves. The invisible window is
  ALWAYS 3 wave-mates regardless of video length, so duplication should not grow with
  scene count — but it has only been measured at this one length.
```

### Stage 2b — retry 32 with a native decode gate  ⬜ READY, NOT YET RUN

The Stage 2 crash was never root-caused, so instead of chasing it the native surface was
BOUNDED. Scene concurrency and native-image concurrency were the same number, which is
the actual design error: at 32 scenes the build had ~160 simultaneous skia decodes.

`_normalizeVisionImage` now sits behind a gate (`VISION_DECODE_CONCURRENCY`, default 8).
Scene concurrency stays 32 — that is where the speed comes from, and it parallelises
downloads, searches and agent calls too — while native decoding stays at a level with
hours of clean runtime behind it.

Verified in isolation: 60 concurrent callers -> 60/60 ok, peak simultaneous decodes 8.

```
RESULT (2026-09-01): ✅ PASSED — the decode gate is the answer.

  Ran conc=32, decode gate=8, VP waves=4, vision cap=40, on ONE instance (see below).
  Completed all 31 steps, exit 0, 115m53s (21:24:42 → 23:20:35).
  Previous attempt at the same concurrency: exit 3221225477 (ACCESS_VIOLATION) at 20 min.

  Crash signatures in 70k+ log lines : 0
  unjudged                           : 0      (quality gate held)
  vision calls / errors              : 5684 / 0
  bedrock fallbacks                  : 2 of 5684
  HTTP 429 / rate-limit messages     : 0      ← answers Stage 4, see below
  scenes with media                  : 340/340

  Conclusion: scene concurrency and native-image concurrency being the same number WAS
  the bug. Decoupling them survives 32 where coupling them died at 20 minutes. The exact
  faulting call is still not isolated and does not need to be — the surface is bounded.

DECISION: keep conc=32 with the decode gate at 8. Do NOT raise VISION_DECODE_CONCURRENCY
  to chase speed; it buys nothing (the GPU, not the decoder, is the vision floor) and it
  is the one thing standing between this build and a 20-minute segfault.
```

**The test**: last crash was scene 47 after 20 min. Pass that cleanly and the gate is the
answer. Crash again and it is NOT the decode path — go after it from another angle rather
than repeating this.

#### Instance count is NOT ours to choose — Azure H100 capacity is a hard gate

Redeploying `qwen--qwen3-vl-30b-a3b-instruct-fp8` on 2026-09-01 at the planned 8 instances
was refused by the portal:

```
Capacity                          Insufficient
Capacity required:   8 Accelerators
Available capacity:  1 Accelerators
```

The Deploy button stays **disabled** at 8 and enables at 1 — this is a submit-time gate, not
a warning. "Capacity is shared across this service and can change", so it is regional pool
availability, not our subscription quota, and it fluctuates: the 2026-08-31 run got 8.
Deleting the idle Ornith deployment does not help — that is MI300, a different pool.

**Check this panel before planning any run around an instance count.** A plan that assumes 8
is a plan that may not be deployable that day.

Measured on the 1 instance actually available: 120 concurrent judges, 0 failures, 50.7 s wall
(~2.4 calls/sec, 0.42 s/call amortised). At ~18 vision calls/scene × 345 scenes that is
~43 min of vision for the whole build — slower than 8 instances but NOT the catastrophic
floor the 1-instance/conc-4 baseline (24 s/call) suggested. So this is a valid crash test.
It is **not** a valid speed measurement — do not fill in a wall-clock number from this run
and compare it to the 8-instance projection.

#### One code change was required to make 1 instance safe

The in-flight vision limiter (`_acquireVisionSlot`) wrapped only the two Qwen lanes;
`_azureManagedVision` had **no cap at all**. That was survivable at 8 instances and is not at
1: `MEDIA_SCENE_CONCURRENCY=32` aims ~160 scoring calls at a single GPU. That does not fail
cleanly — it stretches latency until calls time out, and a timed-out judge reads downstream
as `unjudged`, i.e. silently worse footage rather than a visible error. Exactly the failure
the quality gate exists to catch, arriving for a reason unrelated to what we are testing.

`_azureManagedVision` now goes through the same limiter, and `VISION_MAX_CONCURRENCY` is a
backend-neutral spelling of `QWEN_VISION_MAX_CONCURRENCY` (the Qwen name still wins when set,
so the Lightning auto-config is untouched). Unset/0 = unlimited = previous behaviour exactly.

### Stage 5 — stop scenes borrowing footage  ⏸️ PAUSED MID-RUN, resume on request

User's rule, and it reframes the whole media effort: **a borrowed clip is a FAILURE, not a
fallback.** The only win is the scene finding its own footage. Do not report a borrow rate as
an acceptable outcome and do not offer "keep motion, accept the borrowing" as an option.

Baseline to beat, from the 2026-09-01 build: **154 of 340 scenes borrowed (45%).**
Baseline plan saved at `scratchpad/baseline-video-plan.json` for a direct diff.

Three fixes are IN and verified (`npm run verify` clean apart from the pre-existing
`slop-lint`), none yet proven by a build:

1. `providers/base-provider.js` — the socket now clamps to `deadlineAt`, which was already
   being passed and never read; the retry loop stops once that deadline passes.
2. `agents/ai-visual-planner.js` `_applySemanticSourceRouting()` — the `generic-broll`
   branch was the only one that overrode an explicit lane with no specificity test. It now
   needs the subject to read generic AND the app to rate the scene findable
   (`retrievability`, which is derived from scene CLASS so it behaves the same on warships
   and pantry shelves). Replayed on real data: spares the 90 scenes that scored 44% on
   stock, keeps the 42 that scored 60%.
3. `media/footage-manager.js` cross-type fallback — **the big one.** It reached the
   web-image lane correctly (and already flips `scene.mediaType`), but passed the STOCK
   query, and `forceKeywordQuery` then disabled planner-query recovery downstream
   (`forceExactWebImageQuery`). The 89%-winning lane was being asked the wrong question by
   construction: 131 tries → 15 wins as a rescue, vs 89% as a primary. Now passes
   `scene.webQuery`. Reaches 98 of the 154 borrowed scenes with a different query.

**Correction for whoever reads the earlier notes**: Bing/Brave are NOT structurally
unreachable from a video scene. `VIDEO_PRIORITY` excludes them, but the cross-type fallback
routes through `fallbackSourceHint='web-image'` and gets there. No change to the priority
maps is needed — the defect was the query, not the route.

```
RESULT:   cold build launched 2026-09-02, STOPPED BY USER a few minutes in — resume when
          the user says to continue. Nothing was measured; the run proves nothing yet.
DECISION: (pending the re-run)
```

**On resume**: the project was already reset (checkpoints, `temp/`, `public/` cleared), so
just relaunch cold and compare borrowed-count against 154. Also still unmeasured from
Stage 3: keyword duplication was 1.23% and wants a second data point.

Not addressed yet: 237 race candidates were skipped for "no scene budget", i.e. the rescue
lane is reached with the clock already spent. Fix 1 buys some of that back; if borrowing is
still high after the re-run, reserving a budget slice for the highest-yield lane is the next
lever.

### Stage 4 — provider throttling, IF it appears  ✅ NOT NEEDED

Contingency was: multiple API keys per provider, rotated the way the Qwen vision key pool
already works. Pexels and Pixabay both allow several keys.

```
RESULT (2026-09-01): the full conc=32 build produced ZERO throttling.
  HTTP 429            : 0
  rate-limit messages : 0
  (baseline for comparison: 3 throttle events in 2 h at concurrency 8)

  Provider mix that sustained it: 155 Pexels Videos, 119 Bing Images, 22 YouTube Videos,
  15 Brave Images, 7 Pixabay Videos, 4 Pixabay Images, 2 Pexels Images.

DECISION: do NOT build multi-key rotation. It was speculative work for a limit that does
  not bind at 4x the previously measured rate. Revisit only if 429s actually appear.
```

---

## Rules for whoever runs this

- **Measure before optimising.** Every number above came from a log, not an estimate.
- **One variable per run.** Do not change concurrency and instance count together unless
  the projection says vision would otherwise become the floor.
- **The tail of the 15-Foods video is not a valid benchmark.** Scenes ~180+ are abstract
  ("vinegar sediment", "documentary background") and find nothing regardless of speed.
  Compare on scenes 20-180.
- **Quality gate**: `unjudged` must stay 0. If it climbs, stop — speed that skips vision
  scoring is not speed, it is silently worse footage.
- Run `npm run verify` after any code change. Known pre-existing failures: `slop-lint`,
  `partial-render-range`.

## Changelog

- **2026-09-01** — Stage 2b launched. Azure H100 capacity allowed only **1 instance**, not
  the planned 8 (hard submit-time gate; see Stage 2b). Load-tested that instance at 120
  concurrent: 0 failures. Found and closed a gap the 1-instance constraint exposed — the
  vision in-flight limiter never covered the azure-managed lane, so a single GPU would have
  been flooded and the resulting timeouts would have shown up as `unjudged`, corrupting the
  quality gate. Run is a crash test only; its wall clock is not a speed number.
- **2026-08-31 (later)** — Stage 1 (conc 16) ran clean; killed early, it was only a
  stepping stone. Stage 2 (conc 32) CRASHED with a native ACCESS_VIOLATION; five
  candidate causes tested and ruled out. Wave planner confirmed working. Falling back
  to 16. Also found and fixed: TWO hardcoded concurrency caps (raising one silently did
  nothing), and an unguarded canvas load in icon-director.js.
- **2026-08-31** — plan created. Baseline measured at 1× and 4× instances. Bottleneck
  analysis shows model is only ~40% of wall time; scene concurrency identified as the
  real multiplier. Stage 1 next.
