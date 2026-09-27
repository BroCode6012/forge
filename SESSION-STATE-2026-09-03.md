# Where we stopped — 2026-09-03

## RESULT: THE JUDGE FIX WORKS

```
run                scenes  borrowed  borrow%
baseline (bar)        340       154    45.3%
run2 lane fix         366       174    47.5%   (reverted)
JUDGE FIX             346         2     0.6%
```

**Borrowing collapsed from 154 scenes to 2.** Build exit code 0.

**Honest caveat — this is NOT a clean single-run measurement.** Of 346 scenes, 266 were
`resumed` (media already on disk from the earlier partial runs) and only **80 were processed
fresh this run — 2 of those borrowed (2.5%)**. The improvement accumulated across several
partial runs on the same project rather than being proven in one cold pass. A cold build has
not been measured. The 2.5%-on-fresh-scenes figure is the most defensible comparison, and those
80 were the leftover hard scenes.

**Vision was verified working — not blind acceptance** (the dangerous failure mode):
2,199 judgements, 1,605 rejects (73%), scores still clustering at 1-3. All 346 media files
present on disk, none missing, none truncated.

## THE FIX (live in `src/vision/ai-vision.js`)
The judge graded footage against the planner's full DIRECTED SHOT ("animated arrow pointing to
a honey jar with moisture label"), so real honey clips scored 2/10 for a missing arrow that
never existed. It now judges the SUBJECT of the narration and ignores invented staging
(arrows, labels, overlays, actors, expressions). Off-topic still rejects. Topic-neutral —
verified 10/11 across food, military, tech, history, nature.

Also live: download socket clamps to `deadlineAt` (base-provider.js); cross-type rescue passes
`scene.webQuery` instead of the stock keyword (footage-manager.js).

## REVERTED — DO NOT REDO WITHOUT NEW EVIDENCE
Three lane-routing fixes, all made it WORSE (45.3% -> 47.5% -> 54.5%): the `generic-broll`
override in `_applySemanticSourceRouting`; rewriting the planner's source-lane guidance; the
live lane scoreboard (`betterLane`, still exported + unit-tested, call site removed).
**Why they failed:** web-image's 89% win rate was SELECTION BIAS — the 62 easy scenes the
planner was most confident about. Sending harder scenes there dropped it to 62%. Never
optimise toward a per-lane win rate.

## THE SEGFAULT — ROOT-CAUSED AND CLOSED

**Signature reproduced:** a TIFF handed straight to `@napi-rs/canvas` `loadImage()` gives
`exit 139 / Segmentation fault` — no exception, no Windows event-log entry, and no Node report
even with `--report-on-fatalerror` (skia faults below Node's signal handling). That total
silence is why every earlier hunt came up empty.

**Chain that closes it:** a SIGSEGV with no catchable error must be native; `moduleLoadList` +
require-cache prove **skia is the only third-party native module in the build path** (sharp and
onnxruntime are transitive, never required by `src/`); the guarded sites and the vision hot path
are proven safe under stress (**4,800 normalizes at concurrency 24, no crash, rss flat
292->300MB**); therefore the crash entered through an unguarded skia input — and there were
exactly three.

**Fixed — three `loadImage` sites decoding remote web bytes with no `isCanvasSafeImage`:**
- `src/media/storyboard-scout.js:296` — JPEG slices from yt-dlp's MHTML storyboard bundle
- `src/map/map-provider.js:734` — MapTiler tile bytes
- `src/media/icon-provider.js:305` — iconify SVG; guard the RAW BYTES, not the `data:` URI
  (a data URI sniffs as an unreadable path, where `isCanvasSafeImage` fails OPEN)

Already guarded, untouched: `ai-provider.js:2590`, `footage-manager.js:2130`,
`thumbnail-vision.js:415`, `icon-director.js:115`. `article-image.js` is a FALSE POSITIVE —
`downloadImage(` contains the substring `loadImage(`; it never requires canvas.

**Killed by direct test — do not re-run:** truncated JPEG (skia decodes a 10% file fine); every
permitted format (webp incl. animated, gif, bmp, png); native-memory leak (flat over 4,800
normalizes); `aborted mid-stream` (appears MORE in clean runs — 918/996 vs 85-344, pure noise);
storyboard volume (the cleanest run used it most: 333 lines, exit 0).

**Honest limit:** the CLASS is closed, not the individual instance — which of the three fired is
not established. Weak pointer: stage5d's last active storyboard run sits 81 lines before its crash.

**Verification:** `npm run verify` fails identically WITH and WITHOUT these changes (one
pre-existing `overused-font: lato` slop finding in `hyperframes-bridge.js`, proven by stashing
the three files and re-running). `verify:paths` clean, all three modules load.

## AZURE — BILLING NOW
Redeployed 2026-09-03 11:32: `qwen--qwen3-vl-30b-a3b-instruct-fp8`, Global Managed Compute,
**H100_80GB x 2 instances = $15.82/hr** (was MI300 before; H100 is $7.91/instance/hr).
**DELETE IT WHEN NOT IN USE** — Foundry -> project -> Models + endpoints -> Delete.
Deployment name kept byte-identical so `.env` needs no edit (it points at the PROJECT
endpoint, not a per-deployment URL).

**Env trap confirmed:** the user-layer `.env`
(`C:/Users/user/AppData/Roaming/yta-empire-webgl/.env`) sets `VISION_BACKEND=lightning` and
loads with `override: true`. Headless runs don't set `YTA_USER_ENV_PATH`, so the repo `.env`
(`azure-managed`) wins. **A build launched from the UI would use Lightning, not this
deployment.**

## PROJECT LOCATION
`D:/Youtube/BENCH-15-Foods-parallel-test` (C: had hit 0 bytes). Always resume, never rebuild cold:
```
PROJECT_DIR="D:/Youtube/BENCH-15-Foods-parallel-test" BUILD_RESUME=true BUILD_REPEAT_FROM=media node src/pipeline/build-video.js
```
Archive of every plan + log: `D:/Youtube/.bench-archive/`

## NEXT
1. Delete the Azure deployment if not building ($15.82/hr).
2. The plan is complete and renderable — render it and watch for the borrowed-footage look.
3. For a clean number: a cold build on a fresh project copy (expensive; optional).
4. Root-cause the segfault properly rather than dodging it with low concurrency.
5. Disk pre-flight didn't stop a 0-byte disk — a full disk surfaced as a segfault.

## PROCESS NOTES
- Check the exit code of EVERY build and report failures immediately.
- Verify a mechanism actually FIRES before shipping it (the lane scoreboard never fired once).
- Test prompt changes against real recorded cases before spending a build (caught 2 bad drafts).
- Don't act on a plausible story: 3 wrong crash theories (decode gate, concurrency, disk) each
  cost a run. The raw task output said "Segmentation fault" all along.

---

# COLD RUN — 2026-09-06 (the clean measurement)

`D:/Youtube/BENCH-COLD-2026-09-06`, input audio only, no temp/checkpoint/cached media.
conc=16 decode=8. **exit 0 in 3h30m (13:09:49 -> 16:40:07).**

```
run                scenes  borrowed  borrow%
baseline (bar)        340       154    45.3%
run2 lane fix         366       174    47.5%   (reverted)
resumed run           346         2     0.6%   (inflated - 266 scenes resumed)
COLD RUN              348        32     9.2%   <- the honest number
```

**45.3% -> 9.2% on one cold pass. 122 scenes rescued.** This supersedes the 0.6%, which was
inflated by resumed media.

**Vision was genuinely judging, not rubber-stamping:** 3,874 judgements, still bimodal — 3,043
scored 1-3, only 497 scored 7-8 (~13% accepted). All 348 media files present, none missing,
none truncated.

**THE SEGFAULT FIX HOLDS.** First full cold build since the three unguarded `loadImage` sites
were closed. Four builds died at exit 139 before; this one ran 3h30m at conc=16 and exited 0.

**The footage library populated itself** at `D:/Youtube/Studio/_footage-library/explainer.diy/`:
900 sources, **315 winners, 276 rejects**, 234 asset files, 1.31 GB.

- **The reject fix works** — 276 rejects recorded where the old code produced 0, because
  footage-manager never called `rememberMediaSource` with `status:'rejected'`.
- **`channels: 0`** — a bench project has no Studio link, so `channelSlug` was empty and the
  within-channel repeat guard has no data yet. It will fill in on a real Studio-fed build.
- **Filed under `explainer.diy`, not `explainer.food`** — the Director read a stockpiling video
  as DIY/prepping. Defensible, but it decides which library future videos share, so worth a
  look before many videos accumulate under the wrong niche.

**Still not wired:** querying the library BEFORE the providers. The library now has real data
(900 sources, 276 known-bad), so the hit rate can finally be measured. That is where the speed
is — this run still paid for all 3,874 judgements.
