# SESSION HANDOFF — read this to continue exactly where we left off

> Maintained by Claude. Updated July 6, 2026 (doc/memory resync). If you are a
> fresh Claude session (any account): read this + MEMORY.md (auto-loaded) and
> you have full context. The literal transcript backup lives in
> `.claude-session-backup/` (jsonl files — restorable to
> `C:\Users\user\.claude\projects\D--Youtube-YTA-EMPIRE-WEBGL\`).

## ▶️ NEXT SESSION — START HERE (set July 31, 2026, end of day)

**The Jul-29 media diagnosis is now FULLY SHIPPED. The news flip + Fixes 1–5 are
all done, gated and green.** `npm run verify` exits 0;
`scripts/verify/media-adaptivity.js` is **72/72 across 9 sections**.

| Item | Task | Status |
|---|---|---|
| Flip news topics off stock-first | #30 | ✅ shipped |
| Fix 1 — adaptive per-download patience | #28 | ✅ shipped |
| Fix 2 — ladder that advances + learns | #29 | ✅ shipped |
| Fix 3 — a dud must not be recorded as a win | #31 | ✅ shipped |
| Fix 4 — stop mangling the search terms | #32 | ✅ shipped |
| Fix 5 — read your own handwriting (judging + GPU) | #33 | ✅ shipped |
| Fix 6 — unreadable scorecards in the deep clip check | #21 | ✅ shipped |

**The next thing to do is RUN A REAL BUILD** and diagnose the new log. Every fix
above was derived from `app-2026-07-29T12-09-59-389Z-33380.log`; nothing since has
been measured against a live run. The numbers to check in the new log:
scenes shipped with no media (was ≥1), `no winner after N batch(es)` count,
`[Vision] model unavailable` count (was 31), strict-raw penalty firings and how
many of them killed a 7/10, and total media-phase wall clock.

**Still open, NOT part of any current user request** (do not start these unsolicited):
- Tasks #25 / #26 — render speed Tier 3 (6 workers) + per-frame profiling.
  Render speed is already shipped and verified (15m18s → 11m24s); these are
  optional extras, and 6 workers is questionable on this hardware.
- `transcript-scout.js:105` latent `signal: null`; media-memory-bank keeping a
  second full copy of every accepted master; `temp/` at 2.4 GB; ~16% of authored
  comps overrunning their briefed duration; non-deterministic `graphicShell`.

**Standing:** the user is not a developer — explain everything in plain language,
no file paths, no line numbers, use tables and analogies.

### ✅ FIX 6 — SHIPPED July 31, 2026. Task #21 CLOSED.

**The deep clip check could not read its own judge's answer.** Same bug shape as
the one fixed in `ai-vision.js` on Jul 30, in `src/media/clip-analyzer.js` — both
parsers (`_parseClipAnalysis` and `_parseWindowValidation`).

Two distinct defects, one root:

1. **`score: 0` used as the "not parsed yet" sentinel** while every parse path
   clamps with `Math.max(1, …)`. A score that *was* read can therefore never be 0,
   so every 0 was an unread scorecard wearing a verdict's clothes. Sentinel is now
   `null`; the external contract is unchanged (`{score: 0, parseError: true}`)
   because `footage-manager` gates on `typeof score !== 'number'`.

2. **The fallback invented scores out of prose.** It took the *first number
   anywhere* in the reply: `response.match(/(\d+)…/)`. "CONTENT: 4K aerial drone
   shot" → **4**. "3 workers laying clay pipe" → **3**. Both below every accept
   floor, and both look like a genuine rejection in the log — so this was strictly
   *worse* than the ai-vision case, which at least failed visibly. Now anchored:
   a score/rating label, a lone number on its own line, an explicit N/10, or a
   punctuation-separated merged tail (`"… soil layers. 7"`). Nothing else.

Also added the decoration-tolerant score-line reader (`**SCORE: 8**`, `- SCORE: 8`,
`Final score: 6`, bare `8`, `8/10`) — the strict `SCORE:` prefix runs FIRST, so every
reply that parsed before parses to the identical value.

**Unreachable documented intent, now reachable:** `footage-manager.js`
`_scoreVideoMerged` already carried the comment *"If merged call fails (AI
unavailable / parse error), fall through to the per-frame path so we don't drop the
clip silently"* — but the parser never signalled a parse error, so the branch could
never fire. It now does, *after* the description-based sanity floor gets its chance
first (so the cheap rescue is still preferred over re-scoring).

Gated by **section D of `scripts/verify/vision-score-parse.js`** — 7 sub-sections,
the file is now **104 checks**, and the anti-regression guard for the greedy
fallback was itself proven non-vacuous against the old source line.
Full gate: `npm run verify` EXIT=0, `ALL PASS — 23 passed, 0 failed`,
media adaptivity 72/72, render-media-reuse 21/21.

### ✅ FIXES 3 + 4 + 5 — SHIPPED July 31, 2026. Tasks #31, #32, #33 CLOSED.

All three obey the user's governing rule (`memory/feedback_media_fixes_must_be_niche_adaptive.md`):
**one global mechanism, per-topic inputs, learns in-run — a flat constant is as
banned as an `if (niche === 'x')`.**

- **Fix 3 — a dud is never recorded as a win.** Failure was being written into the
  same success ledger as a real find, so the in-run memory learned from noise and
  the rescue ladder thought it had already succeeded. Now the outcome classifier is
  shared, a failed rescue restores the placeholder (no scene ends up *worse* than
  before the rescue ran), and there is a road back for a provider that was demoted.
- **Fix 4 — stop mangling the search terms.** Three defects, one symptom: the shop
  was asked for half a name and then the judge graded the delivery against that
  same half a name. (4A) `trimSearchKeyword` cut "root cellar" → "root" and deleted
  "view" out of the middle of "aerial view"; compound nouns are now learned from
  the script itself via `src/media/phrase-atoms.js` — **promotion counts distinct
  SOURCES, not sightings**, and a scene cannot corroborate itself. (4B) the full
  untrimmed request (`fullVisualIntent`) now reaches every vision/clip judge, and
  **`visualIntent` was deliberately kept OUT of `_visionCacheScope`** — adding it
  would invalidate and re-bill every cached verdict in every project. (4C) the
  findability re-check moved to Step 4.87, *after* Template Rhythm invents new
  queries, and only re-judges changed indices so an unchanged script costs £0.
- **Fix 5 — read your own handwriting.** New `src/media/packaging-intent.js`
  (zero requires) + edits to media-hunter, relevant-person-rules, smart-segment,
  search-keywords, niches.js, vision-score-sanity, clip-analyzer, ai-provider.
  - **(i) The scene's own brief is now read before judging.** Scene 59 of the
    Jul-29 build asked for a "cross-section diagram … temperature indicators …
    soil layers", the app then stripped "diagram" from the YouTube query, found two
    clips matching the brief line-for-line, and demoted both for being diagrams →
    `no winner after 2 batch(es)` → **scene shipped with no media**. A packaging
    layer the request itself named is the *delivery*, not a defect.
  - **Evidence rule (load-bearing):** only *statements of what to fetch* count —
    the live query, the planner's full `visualIntent`, and the Media Agent's
    `mustShow` / `mandatoryVisible` / `subjectAnchors` / `prefer`. **Narration,
    `templateHint` and `fullscreenMG` are excluded on purpose** (they describe the
    overlay the renderer DRAWS, not the footage to BUY) — which is exactly why
    `_isGraphicScene` in media-hunter could not be reused.
  - **`ignoreQuery` (subtle, do not remove):** a caller *editing* the query must
    pass it, or the query justifies its own words and the filter is a permanent
    no-op. A caller *judging* a downloaded clip leaves it off. Two different
    notions of "requested", deliberately.
  - **(ii) The demotion was a FLATTENING, not a demotion.** `Math.min(6, base - 2)`
    against an accept floor of 6 meant 8/9/10 all squashed to exactly 6 and passed
    while a plain 7 → 5 and died — the most common good score was the only one that
    could not survive. Replaced with monotonic severity-scaled subtraction:
    text 1, graphic 2, graphic+text 3, presenter 4, all three 5.
  - **Learns in-run:** `packagingRelief()` softens by −1 after 8 observations with
    <25% clean, −2 after 16 with <10% — i.e. only once *this run* has proven clean
    raw footage isn't retrievable for this topic. **A presenter keeps a hard floor
    of 3 under full relief** so a talking head can never slip into a faceless video.
  - **`strictRaw` was NOT flipped.** Flipping `allowGraphics` would also disable
    dense frame sampling, `TEXT_HEAVY_AVOID_TERMS`, the cap-4 clamp and ~25 other
    call sites. The fix adds a NEW `requestedPackaging` field *beside* it.
  - **(iii) The rented GPU was declared dead 31 times when it was merely busy.**
    One box + one model + one key means a 429 is backpressure, not exhaustion; the
    flat 30s bench emptied the pool and dumped everything on paid Bedrock. Now
    self-hosted 429/503/529 → longer retry ladder + ~4s bench; a genuinely
    rate-limited HOSTED key (dashscope/aliyuncs) still gets the full 30s.

### ✅ FIXES 1 + 2 — SHIPPED July 31, 2026. Tasks #28 and #29 CLOSED.

Both fixes from the Jul-29 media diagnosis are done, gated, and `npm run verify`
passes (exit 0). Scratch files cleaned up.

- **Fix 1 — adaptive per-download patience.** New `src/media/download-patience.js`.
  The per-candidate race timeout was ONE app-wide constant and the user's `.env` set
  it to `0` = wait forever, so one slow pull ate whole scenes and starved every
  rescue rung behind it (26 refusals + 34 deadline-grace extensions in that build).
  Patience is now `measured download cost × the topic's own footagePriority rank ×
  the provider's live record`, clamped to `MAX_SCENE_SHARE = 55%` of the scene's
  remaining time. Proof it is per-topic: `explainer.diy` gives youtube ~105s /
  pexels ~75s; `news.politics` gives youtube ~64s / pexels ~105s — same code.
  The three `*_RACE_CANDIDATE_TIMEOUT_MS=0` lines in `.env` were commented out and
  left empty so adaptive engages; env `>0` is still honoured verbatim, and `0` is
  still honoured but now warns loudly once.
- **Fix 2a — the niche allowlist became a demote.** `getSmartPriority` used
  `footagePriority` as a hard allowlist. Since all ~21 niches list only
  `pexels, pixabay` for images, **brave was deleted from every topic in the app**
  and unreachable; bing only survived via a hardcoded `allowedSet.add('bing')`
  rescue (now removed). Two edits were needed, not one: (i) demote-not-delete, and
  (ii) a **completeness tail** — when the niche list is what *generates* the order,
  the other providers were never in it to begin with, so every remaining provider
  from `VIDEO_PRIORITY` / `IMAGE_PRIORITY` is now appended at the tail. Real bans
  (`excludeVideoProviders`, `DISABLED_VIDEO_PROVIDER_KEYS`, the UI switch) still delete.
- **Fix 2b — in-run provider scoreboard.** New `src/media/provider-scoreboard.js`.
  Laplace-smoothed win rate per (mediaType, provider); needs `MIN_EVIDENCE_OPENS = 3`
  before it acts, moves a provider at most `MAX_SHIFT = 2` places (implemented as
  bounded bubble passes so the bound holds *by construction* — a sort-then-clamp
  cannot honour it), never drops a provider, never persists to disk. The ladder now
  records open/win/loss and logs `[Provider Ladder] … Never opened: …` on every
  early exit, which is how 8 scenes shipped with no footage unnoticed.
- **Gate:** new `scripts/verify/media-adaptivity.js`, 27 checks, wired into
  `npm run verify` and available as `npm run verify:media-adaptivity`. It caught a
  real gap in the first attempt (the completeness tail above), which is why it exists.
  `footage-manager.js` now also exports `_getSmartPriority` purely as a test seam.

**Not yet done from that plan:** Fixes 3, 4, 5 (see START HERE above).

## ✅ FINDINGS A + B — SHIPPED July 30, 2026 (morning). Task #20 CLOSED.

> Diagnosed 2026-07-30 ~00:45, **fixed and verified 2026-07-30 morning**. The diagnosis
> below is preserved verbatim because it is the reasoning trail; the "PROPOSED FIX
> DIRECTION" section now records what was actually applied. Both bugs are FIXED,
> gated by a new 60-check regression test, and `npm run verify` passes **23/23**.
>
> **What shipped, in one line each:**
> - **A** — the score sentinel is now `null` (never `0`), the parser reads `**7**` / `7.` /
>   `7/10` / `Score: 7` / a score merged onto the end of the description, and a *parse*
>   failure no longer masquerades as a *dead API*, so a healthy vision model can never
>   abort a footage race again.
> - **B** — Bedrock's image `format` is now derived from the BYTES on both the single-image
>   and multi-frame paths; undecodable bytes are refused/dropped instead of being relabelled
>   `jpeg` by an `||` fallback. The label-based helper was **deleted** so it cannot come back.
>
> **Still open (deliberately, next task):** `src/media/clip-analyzer.js` `_parseClipAnalysis`
> (~:541, clamps at :575/:582) is the same bug shape — `score: 0` sentinel + `Math.max(1,…)`
> clamp — and has NOT been touched yet.

Source of truth for the audit:
- Build log (11,279 lines): `C:\Users\user\Downloads\300$ Test\logs\app-2026-07-29T12-09-59-389Z-33380.log`
- Build summary: `C:\Users\user\Downloads\300$ Test\logs\build-summary-2026-07-29T12-13-29-212Z.log`
- The build: 61 scenes (S0–S60), 1 h 20 m 45 s total. Step 5 (media) = **51 of those 81 minutes**.

### FINDING A (headline, MEASURED BY ME DIRECTLY — not agent-dependent)

**A genuine vision score of 0 is IMPOSSIBLE to produce. Every "0/10" in the log is a
failure to PARSE the model's answer — never the model's verdict.**

Mechanism, all in `src/vision/ai-vision.js` `analyzeImage` (~:478–545):
- `let score = 0` is used as the "not yet parsed" **sentinel**.
- All three parse paths clamp with `Math.max(1, …)` — lines **494, 505, 524** — so a
  successfully-parsed score can never be 0. The sentinel and a real verdict can therefore
  never collide… which means the ONLY ways out with `score: 0` are the two failure returns:
  `{score:0, parseError:true, errorMessage:'vision response missing numeric score'}` (:532–536)
  and `{score:0, description:'Vision AI error', apiError:true}` (:544).
- The primary parse requires the number **alone on its own line** (`/^(\d+)$/`, :493).
  Modern models routinely answer `3/10`, `Score: 3`, `**3**`, `3.` — none match.
- The fallback regex (:504) needs the literal word score/rating, or a bare number alone on a line.
- One strict-format retry exists (:515) and evidently still fails often.
- `smart-segment.js:595` prints `result.score/10` → that is the "Post-download score: 0/10" line.

MEASURED on the real log:
- Score distribution: **0→66**, 1→26, 2→57, 3→67, 4→6, 5→3, 6→24, 7→79, 8→8. (336 judged; nothing ≥9.)
- **66 of 336 = 1 in 5 candidates binned after being correctly judged.**
- `grep -c "Post-download score: 0/10 → Vision AI error"` = **0**, and `grep -c "Vision AI error"` = **0**
  → **none** of the 66 were API errors. All 66 are parse failures.
- 59 of the 66 carry a rich, accurate description (`0/10 → [A-Z]`), e.g. *"A modern, well-lit
  tunnel with metallic walls and escalators, not matching the underground earth tunnel"*.
  The model SAW and UNDERSTOOD the image. We threw the answer away.

**The snowball (this is what actually wrecked the build):** the parse failure is reported
upward as *"vision API unavailable — candidate left unjudged"* (`footage-manager.js:6392`,
logged at `:6411`). `footage-manager` then hits *"vision API unavailable for ≥half the batch —
aborting race (saves budget on un-judgable candidates)"* (**9×**) → *"no winner – provider exhausted"*.

⚠️ **COUNT CORRECTION (I first wrote 88; that was an over-count).** `grep -c "vision API
unavailable"` = 88, but that string also appears in the batch-abort message. The real
breakdown: **59 candidate-level unjudged events**, 9 batch aborts, rest incidental.
**All 59 carry the identical parenthetical `(vision response missing numeric score)` — i.e.
100 % are parse failures — and `grep -c "unjudged (The model returned"` = 0, so ZERO were
caused by a transport/API error.** This makes Finding A *stronger*, not weaker.
**So a vision model that is working correctly and rejecting junk causes the search to
self-destruct. The better the model gets, the worse this bug bites.** Downstream: 5 scenes
fell to drawn "Agentic Visual Fallback" (S13, S48 = "fallback"; S26, S41, S51 = "timeout recovery").

Timeline proof: first unjudged 12:31:52 Z; **last unjudged 13:18:24 Z = the exact second S59
finished** (S59 alone ran 14:07:09→14:18:24 local = 11 m 15 s, last thing in the step).
Media step 13:27:17→14:18:40 local, so **47 of its 51 minutes ran in this state.**

SIBLING SITE (same bug shape, not yet assessed): `src/media/clip-analyzer.js:575` and `:582`
use the identical `Math.min(10, Math.max(1, parseInt(...)))` clamp.
`src/vision/vision-score-sanity.js:268` already special-cases `parseError` — check interaction
before changing anything.

### FINDING B (also measured by me directly)

**Multi-frame Bedrock vision declares the image format from an unreliable label instead of
sniffing the bytes → hard 400 that kills the whole fallback chain.**

- `_bedrockVideoVision` (`src/brain/ai-provider.js:~3342`, sole caller :3591) sets
  `format: _bedrockImageFormat(frame.mimeType || 'image/jpeg')` — **no magic-number check**.
  This is a real gap, but it is NOT the path that failed in this build.
- ⚠️ **I FIRST WROTE THAT THE SINGLE-IMAGE PATH IS IMMUNE. THAT IS WRONG — the audit refuted it
  and it is the path that actually fired.** It does sniff (`_detectImageFormatFromBytes(imageBytes)
  || _bedrockImageFormat(mimeType)`, :3285) — but when the bytes are **not a decodable image at
  all**, the sniff returns `null` and the `||` silently re-substitutes the lying `'jpeg'`,
  **defeating the sniff exactly when it is needed**. The existing fix only ever protected against
  a *valid image of the wrong format* (real PNG labelled JPEG); it does nothing for non-image bytes.
  So the correct framing is **not** "fixed once, twin missed" — it is "the guard has a hole, and the
  batch path additionally has no guard at all". **Fixing only the twin would not have fixed this build.**
- How bad bytes get there: `_normalizeVisionImage` (:2081) catch (:2119) returns the ORIGINAL
  undecodable bytes still labelled `mimeType || 'image/jpeg'`, and **only logs when
  `raw.length > maxBytes`** — so small corrupt frames fail SILENTLY (that is why failing calls
  have no `[vision] normalized image …` line). `callVideoAI`'s own catch (:3564) also pushes the
  raw frame through unchanged.
- Error seen: `ValidationException http=400 → The detected file MIME type application/octet-stream
  does not match the expected type image/jpeg` (nova) and `Could not process image` (claude).
  13× each on bedrock-qwen-vl / bedrock-nova / bedrock-claude.

**PROOF it is NOT quota/credits** (I ran this): `bedrock-qwen-vl` had **338 successes vs 13
ValidationExceptions**, the failures **interleaved throughout** the successes (S/E map), and the
**last success (line 9641) came AFTER the last error (line 9323)**. Quota exhaustion clusters and
is terminal; this does not. It is per-payload.
(Separately, 31× `[qwen] Vision error: All Qwen image model/key combos are temporarily unavailable
after rate limits` — that IS the Lightning box, and is a different, real issue.)

### ⚠️ SCOPING CORRECTION — A AND B ARE **SEPARATE**, NOT ONE CASCADE

I initially presented B as feeding A. The audit disproved that, with four independent checks:
- **Reason string:** all 59 unjudged say `(vision response missing numeric score)`; **0** say
  `unjudged (The model returned …)`. A transport failure takes a different return
  (`ai-vision.js:539-543`, `apiError:true`, description `'Vision AI error'`) — and `grep -c
  "Vision AI error"` = **0** in the whole log.
- **Volume:** 13 corrupt payloads vs 59 unjudged — cannot be the same population.
- **Timing:** last Bedrock 400 at 13:06:11 Z, but unjudged continued to 13:18:24 Z, with the
  LARGEST 5-minute bucket (12) at 13:15 — long after the last vision error.
- **Adjacency:** none of the 13 terminal `[bedrock-nova] ❌` errors is followed by an unjudged line.

**Consequence for planning: fixing B recovers 13 frames / 39 paid calls and will NOT shorten the
51-minute Step 5 or recover a single unjudged candidate.** If B ships advertised as "fixes the
unjudged candidates", the next build will look identical. **A is the one that matters.**

Also corrected: the **Lightning GPU was ALIVE the whole build** — the 31 qwen messages are
rate-limiting, not credit exhaustion. Do not go chasing credits. (cf. [[feedback_qwen_quota_model]].)

### ✅ FIX AS APPLIED (all 3 items below shipped as written, July 30 morning)

Files changed: `src/vision/ai-vision.js`, `src/brain/ai-provider.js`,
`src/media/footage-manager.js`, `src/media/candidate-race.js`.
New gate: `scripts/verify/vision-score-parse.js` (60 checks, no network / no AWS — the
vision transport is stubbed via `require.cache` injection). Wired into `package.json` as
both `verify:vision-score` and a link in the main `verify` chain.

Design notes worth keeping:
- The parser is **purely additive**: the original strict `/^(\d+)$/` is tried FIRST in the
  loop, so every response that parsed before parses to the *identical* value (locked by
  test section A3, including the 0→1 and 11→10 clamps). The tolerant reader only ever
  rescues lines that used to fall through.
- `_scoreFromScoreLine` refuses any line carrying extra words or digits, so `"7 floors"`,
  `"4K"`, `"2019"`, `"capacity 80,000"`, `"Route 66."`, `"100"` can never be misread as a
  score (locked by A2/A5). The merged-line last resort **requires** a punctuation separator
  for the same reason.
- Internally the sentinel is `null`; **externally the contract is unchanged** —
  still `{score: 0, parseError: true}`. Returning `score: null` would break callers doing
  `score < 4` (null coerces to 0 → true → would *reject* the clip).
- Measured against the real 2026-07-29 log: all **66** unread scorecards carry a non-empty
  description, so under the new code **every one of them reaches the strict retry** instead
  of being binned.

Both were in-bounds under THE REFACTOR RULE (hardening a byte-format / a parser, not touching
prompt text, taskType routing, cache keys, or a deterministic floor):
1. Widen the score parser to accept `3/10`, `Score: 3`, `**3**`, `3.` etc., and **stop using 0 as
   the not-parsed sentinel** (use `null`) so a real 0 and "unreadable" are distinguishable.
   Then make `footage-manager` only cry "vision unavailable" for TRUE `apiError`, never `parseError`.
2. For B, the sniff-copy is **not sufficient** (see the correction above). The real fix is to
   **refuse to declare a format for bytes that are not a decodable image** — i.e. drop/skip that
   frame instead of falling back to `'jpeg'` via `||`. Apply to BOTH the single-image path
   (:3285, close the `||` hole) and `_bedrockVideoVision` (:3365, add the guard it lacks entirely).
   Also make `_normalizeVisionImage`'s failure log unconditional (it currently only fires when
   `raw.length > maxBytes`, which is why this was invisible).
3. Free observability win, fully in bounds: at `footage-manager.js:6411` split the headline —
   `vision API unavailable` only when `apiError`, `vision score unparseable` when `parseError`.
   Same data, different label, no logic change. Today one headline hides two unrelated populations,
   which is exactly what made me merge them.

⚠️ **OUT OF BOUNDS:** the strict-retry prompt at `ai-vision.js:516` is a PROMPT STRING. Do not
touch it. **It was left byte-for-byte untouched** — the retry block around it was restructured
(a null-leak closed, the retry's own parser widened), the prompt itself was not. Diagnosing
*why* responses lack a digit twice needs the raw response logged first — investigation only,
still a separate open task.

✅ Regression tests added (`scripts/verify/vision-score-parse.js`, **60/60**).
✅ `npm run verify` re-run after the change: **23/23, 0 failed**.

**Audit findings dumped to `D:/tmp/audit-vision.txt`** (survives only until that dir is cleaned —
the authoritative copy is `journal.jsonl` in the workflow transcript dir). 6 findings, incl. a
twin sweep naming **4 sites** that declare an image format to a vision API with no byte check.

### STILL RUNNING WHEN WE PAUSED

Workflow `wf_2de47217-98f` (audit, 5 investigators + adversarial verifiers).
- Transcript dir: `C:\Users\user\.claude\projects\D--Youtube-YTA-EMPIRE-WEBGL\0bf47b31-390f-4e48-b0d1-b596c7619dd9\subagents\workflows\wf_2de47217-98f`
- Script: `…\workflows\scripts\build-flaw-audit-20260729-wf_2de47217-98f.js`
- ⚠️ **The laptop was shut down after this pause, so the run is DEAD and
  `resumeFromRunId` will NOT work — it is same-session only.** Do not try it.
  Instead: **read `journal.jsonl` in the transcript dir** — it persists on disk and holds the
  one completed investigator's full return value (`{"type":"result", …}`). Harvest that, then
  re-launch the remaining 4 areas fresh from the script file if you still want them.
- Status at pause: **1 of 5 investigators done** (the vision one — returned `confidence: high`, agreed
  with Findings A/B independently). Others were on attempt 2, 2, 2 and **4** — agents dying mid-response
  and auto-retrying (same flaky pattern as the render fix). **Read `journal.jsonl` before assuming
  any result is non-empty.**
- Open questions they were chasing: the S59 11-minute tail; whether the 17 scenes with NO success
  line (S2,4,9,12,14,15,16,17,18,19,21,22,27,29,30,31,37) are legitimate MG/template/map scenes or
  silent footage failures; brain spend; residual error shapes.

### ALSO TRUE AT PAUSE
- Fix #11 (caption/transition lanes) is **shipped and verified**; both adversarial skeptics returned
  `refuted: false, confidence: high`. `npm run verify` = 23/23. See the Fix #11 block below.
- Skeptic A logged one honest residual: `timeline_track_too_dense` can now never fire for captions or
  transitions (unique lanes by construction), so that canary is permanently silenced for those families.
- Scratch cleaned: `.tmp/` 7.8 GB → 2.6 GB, `D:/tmp/` ~4 GB → 383 MB. Repo-root personal scratch
  (`.tmp-probe*.js`, `.yt-*.log`, `.yt-*.js`) deleted. `.tmp/map-test` (2.1 GB) left alone — predates this work.

---

## LATEST — July 28–29, 2026: disk/bandwidth waste hunt + image size preference

Context: user's goal is a **universal retrieval capability floor** (find ANY footage
for ANY scene in ANY niche). Niche may express PREFERENCE, never a CAPABILITY CEILING.
User is NOT a developer — **all replies must be plain language, no paths/line numbers/jargon.**
YouTube copyright is SETTLED (user adds editing, scenes ≤10–15 s) — never re-raise it.

### DONE + VERIFIED this session

**Fix #1 — stop downloading 4K masters for 1080p renders.**
New `src/media/providers/rendition-picker.js` (`pickRenderRendition`): take the
SMALLEST rendition that still fills 1920×1080 (`w >= 1920 || h >= 1080`), fall back to
largest when nothing qualifies (capability floor, never a ceiling). Wired into
`pexels-video.js` + `pixabay-video.js`. `reddit-video.js` got the same 1080 default the
YouTube provider already had. `ytdlp-utils.js`: added a trailing uncapped `best` rung to
BOTH format builders so a cap can never make a clip unfindable.
- 12/12 synthetic cases pass. **Live Pexels test on the user's own 4 clips: 155 MB → 67 MB (57% saved)**;
  the already-1080p clip saved 0% (proves no over-reach). API ladders arrive UNSORTED.
- Quality cost MEASURED, not assumed (documented in the module header): 4K→1080 supersample
  scores 42.0 dB vs 38.1 dB for the direct 1080 rung — but crf12-vs-crf18 on the same source
  is 43.6 dB, so **the render transcode is a bigger quality term than source resolution**.
  I had first written "byte-identical" in that comment; measurement refuted it and it is corrected.
- Override: `STOCK_VIDEO_MAX_HEIGHT` (0 = old behaviour, 1440 = buy back half the gap).

**Fix #2 — stop the preview duplicating every clip at full size.**
`src/render/hyperframes-bridge.js`: new `linkOrCopy()` (hardlink, per-file copy fallback);
used in `copyAsset`'s raw branch and in `buildFontFaces`. **MANDATORY companion:**
`fs.unlinkSync(outPath)` immediately before `transcodeVideoForHyperframes` — writing through
a hardlink truncates the shared inode (VERIFIED destructive). Same unlink-before-copy added to
`src/studio/qa-replacer.js`. Hardlink not symlink: `hf-preview://` resolves via
`fs.realpathSync.native` and allowlists only `<PROJECT_DIR>/hyperframes`, so a symlink 403s.
- Real preview build of the real project: **1244.2 MB logical → 18.1 MB actually written**
  (57 hardlinked / 30 copied), HTML generated, 7.8 s.

**Fix #3 — stop re-saving every photo as a full-size PNG. DONE + VERIFIED.**
`base-provider.js:_sanitizeImage` now emits JPEG `-q:v 2` for provably-opaque images and
keeps PNG for everything else; new `_probeImage()` reads dims + pix_fmt from ffmpeg's own
stderr banner via `spawnSync` (NOT ffprobe — this function only ever resolves the ffmpeg
binary; NOT `execSync` — it discards stderr on the expected non-zero exit). New
`OPAQUE_PIX_FMTS` allowlist + `_isOpaquePixFmt()`; unknown/unparsable/`pal8` ⇒ PNG.
Still cap = COVER 2880×1620 (1.5× the render frame), applied only when BOTH dims exceed it,
so nothing is ever upscaled. `subject-image-fetcher.js` cache probe now checks `.png` AND `.jpg`.
- **Whole real project: 142.0 MB → 20.5 MB (6.9×, 86% saved).** 36 → JPEG, 4 kept PNG.
- Average PSNR 50.0 dB across 34 opaque images — visually lossless for photos.
- **`-q:v 2` auto-selects yuvj444p from an RGB source** (verified: forcing `-pix_fmt yuvj444p`
  produces a byte-identical file). So there is NO chroma smear on the baked-in text the
  web-image lane deliberately fetches. Do not add `-pix_fmt`; auto also keeps a 4:2:0 source
  at 4:2:0 instead of paying to upsample chroma that was never there.
- 26/26 probe cases pass, incl. pal8-stays-PNG, rgba-alpha-survives, small-image-not-upscaled,
  tall-image-untouched, corrupt-file-passthrough, no-ffmpeg-passthrough, jpg re-sanitize idempotence.
- `verify:paths` (286 files) and `verify:sacred` (16 anchors) both green.

### OLD IN-FLIGHT NOTES for task #11 (kept for the reasoning trail)

`base-provider.js:_sanitizeImage` (:257) re-encodes EVERY image to **full-size PNG**
(40 files / 149 MB in the test project; one photo is 22 MB). Recon (18-agent workflow,
all [high] confidence) established:
- **Format is the ~9× lever; resolution capping is only ~1.07×** (1 file of 40). Do format first.
- 0 of 40 real project images use transparency. `.jpg` already flows cleanly downstream —
  `copy-to-public.js:53` uses `scene-${i}-asset${ext}`. Vision never sees the full-res PNG
  (downscaled to 1280 + JPEG q82 regardless).
- **`pal8`+tRNS is undecidable by pix_fmt name → must fall back to keep-PNG.** Alpha or
  undecidable or probe-failed ⇒ PNG (today's behaviour). Provably opaque ⇒ JPEG.
- Must switch `execSync` → `spawnSync` to read pix_fmt from stderr. Do NOT use ffprobe
  (`_sanitizeImage` resolves only the ffmpeg binary, :261).
- Correct still cap is **cover 2560×1440, applied only when `W > 2560 AND H > 1440`** —
  stills DO get magnified (Ken Burns 1.15–1.24 × zoom-punch 1.16 ⇒ up to 1.434×), unlike
  video which is capped at 1080 before any magnification.
- **One break to fix: `src/media/subject-image-fetcher.js:48`** probes a hardcoded
  `subject-${slug}.png` cache name; changing the extension silently kills that cache hit.

(That measurement has since been run and the fix shipped — see Fix #3 above.)

**Fix #4 — prefer big photos, never reject small ones.** (User's explicit choice, offered
as an either/or: *"Always measure the real size after download (closing the leak), and push
small photos to the back of the queue so a bigger one wins whenever one exists. A tiny photo
can still be used if it's genuinely the only thing found — so the app can never end up with
an empty scene."*)

The size floor was a **reject**; it is now a **ranking**. Four changes:
1. `base-provider.js:filterResults` — reject → **stable partition**: full-size first (original
   order untouched), undersized appended as a reserve tail with `r._undersized = true`.
   Watermark stays a hard reject. Unknown dimensions rank **NEUTRAL (with the big group)** —
   Bing/Brave usually report no size, and demoting them would gut the retrieval long tail.
   All three call sites (`footage-manager.js:5555`, `:8437`, `topic-footage-scout.js:558`)
   inherit it for free. When nothing is undersized the output is byte-identical to before.
2. `base-provider.js:pickUnused` Pass 3 — used to `return results[results.length-1]`, which
   under the new ordering means "pick the smallest". Now walks back past the reserve tail.
3. **Two upstream floors the user didn't know about, both server-side/query-side so they hid
   results rather than re-ranking them:** `pixabay-image.js` `min_width:1280`+`orientation:horizontal`
   and `bing-image.js` `+filterui:imagesize-large`. Both now **escalate**: narrow ask first
   (unchanged, one request), widen ONLY when it comes back completely empty.
4. **Real size is now measured and authoritative.** The serial download path probed video
   extensions only → now probes every file (the vertical *reject* stays video-only so portrait
   stills are still kept). The end-of-run sweep used to fill only when size was MISSING → now
   measures every file and **corrects** a wrong recorded value, logging each correction.

Verified: **38/38 probe assertions** (never-reject, order preservation, watermark still rejected,
unknown-dims neutral, video untouched, null/empty safe, pickUnused last-resort, Pixabay/Bing
escalation cost + params + logging). `verify:paths` + `verify:sacred` green.
**Real-project evidence (47 files):** 11 recorded sizes were WRONG — stock APIs report the
ORIGINAL (e.g. 5472×3648) while serving a rendition (1880×1253). Aspect ratio was preserved in
every case, so framing was NOT wrong; what was wrong is that the app believed it held a 5472 px
master. Separately, 11 of 36 images in that build are already below 1280×720 — they got in
through `isTooSmall`'s unknown-dimension escape, i.e. the old floor punished the providers that
report an honest size and waved through the ones that report nothing. That arbitrariness is what
this replaces.

NOT done (deliberately out of scope): no resolution term was added to `_winnerQuality`
(`candidate-race.js:74-91`) or `_quality` (`candidate-referee.js:55-72`). They are duplicated
formulas with different clipping (race clips `_mediaScoutScore` to 0..20, referee doesn't), so
adding a term to one desynchronizes the race's early-accept gap from the referee's override gate.
Ordering already delivers "bigger wins when a bigger exists".

**Fix #5 — the stale verify anchor. DONE.** `scripts/verify-fast-media.js` pinned the literal
`if (!fastTest && !openMode)` while `composition-author.js:446` now reads
`... && !graphicsOnly`. Re-anchored on the guard's MEANING (`'!fastTest && !openMode'`) with a
comment saying why a loose anchor is the correct contract here — extra conjuncts only narrow
the gate, which still satisfies it. **`npm run verify` is green again: 23 passed, 0 failed.**

**Fix #6 — orphaned render folders. DONE + VERIFIED.** `hyperframes-bridge.js`: the
"keep newest N" prune read only its own `root`, so any render written to a different
outputRoot was invisible to housekeeping FOREVER. New `_hfProjectRoots()` pools `root` plus
sibling folders whose name starts with `hyperframes`, `_listHfProjects()` sorts newest-first
across all of them (the `yta-hf-<ISO>-…` name makes a string sort a chronological sort), and
`_removeHfProject()` also removes a sibling root once it is empty. Applied to BOTH the normal
prune and the low-disk reclaim. **Safety: a sibling is adopted only when EVERY entry inside it
is a `yta-hf-*` dir**, so it can never reach into a folder holding user content (probe-proven:
a root containing `IMPORTANT.txt` was left untouched). 9/9 probe assertions against the real
`generateHyperframesProject`. **Reclaimed 1973 MB from `300$ Test`.**

**Fix #7 — the screening clock now BINDS. DONE + VERIFIED (live).** `storyboard-scout.js`
checked its deadline only BETWEEN videos, so one slow candidate ran a 45 s budget out to
215.7 s and starved the scene's remaining providers. New `_deadlineOf/_leftMs/_expired`;
the deadline is resolved to an absolute instant ONCE in `screenVideos` and handed down:
it caps the yt-dlp storyboard timeout (was a flat 90 s), and `_ask` stops CLAIMING new images
past it. Calls already issued are allowed to finish — an in-flight vision request has been
paid for and lands in the vision cache anyway, so abandoning it buys the cost without the
answer; overrun is therefore capped at `concurrency` outstanding calls. `locateWindow` (the
~40-call deep scout) had NO clock at all — it now takes one, threaded from `youtube-video.js`
via a new `deadlineAt` on all three `downloadOptions` objects in `footage-manager.js`.
- **A budget-caused failure is never cached** — not in `_boardCache`, not in
  `screenVideo._results`/`locateWindow._results` — and the video's budget slot is handed back.
  "We ran out of time" is a fact about the moment, not about the video; remembering it would
  permanently deny the later, unhurried look (`locateWindow` reuses the same board cache).
- 8/8 stubbed probe assertions + **live proof on real YouTube**: 90 s budget → real verdict in
  15.2 s (`present:true`, 3 calls, 75 frames — unchanged); 6 s budget → stops at 6.6 s;
  the SAME starved video then screened with room returns a full verdict in 17.3 s.
- `npm run verify` green (23/23) after the change.

### Fix #8 — PRE-FLIGHT AUDIT of Fix #7 found four real bugs in it (all fixed + verified)
Before greenlighting a paid build, a 5-lens adversarial audit ran over the uncommitted
media/render changes. Two lenses found nothing. The clock lens found four defects **in the
Fix #7 code written the same day**, three of which survived refutation:

1. **A "no" built from zero vision calls.** `screenVideo` checks the clock right after the
   storyboard fetch, then spends **~1 s measured** packing contact sheets (real JPEG decode +
   re-encode). If the deadline landed in that gap, every `_ask` worker bailed at its claim
   guard, `_bestHit` returned null, and the code built `{present:false, calls:3}` — a
   **truthy** object, so the `if (!result && _expired(deadline))` guard never fired. The
   phantom "no" was then cached for the whole run, and `band()` ranks `!present` (3) BELOW
   never-screened (2), so a video nobody looked at sank under the top-4 cutoff permanently.
   FIX: `_ask` now reports `out.asked` (calls actually issued); a verdict with zero looks
   throws instead of being reported, and `calls` reports the real number rather than the
   number of sheets. Same guard added to the cover-only path.
2. **A failed attempt remembered as a fact about the video.** `_fetchStoryboard`'s catch
   swallowed everything — 429/bot-check, network blip, bad-arg throw — and cached `null`.
   `_boardCache` is module-level and read first, so one transient failure permanently sent
   every later look at that video (including the unhurried deep scout the cache comment
   promises to protect) to the weak cover-only path. FIX: `fetchOk` is set the instant yt-dlp
   itself returns clean. Everything above it is a fact about the ATTEMPT (never cached);
   everything below it is a fact about the VIDEO (cached, so we don't pay twice).
3. **`signal: null` threw and switched the whole feature off silently.** `_sceneAbortSignal()`
   returns `null` (not undefined) when a scene has no controller, and `execFile` throws
   `ERR_INVALID_ARG_TYPE` on a null signal — **verified on this repo's Node v24.16.0**. The
   throw landed in the catch above, so every storyboard fetch failed with no log line. Full
   builds were safe (`downloadAllMedia` always sets `_abortSignal`), but `scene-actions.js`
   deletes it when re-arming a manual per-scene Retry, so the feature was dead on that path.
   FIX: omit the key instead of passing null. (`transcript-scout.js:105` has the same latent
   bug — untouched, noted.)
4. **REFUTED, do not re-raise:** "the storyboard band ordering is thrown away by the title
   rankers". Band order becomes the rankers' `(a.index - b.index)` tiebreak, and the verdict
   also rides on the candidate as `_thumbnailVisionPassed` (weight ×6 in candidate-race /
   candidate-referee — the heaviest non-vision term). Post-change ordering can never be worse
   than the pre-change raw provider order.

Providers lens found one real-but-bounded gap: the **small-image reserve tail was discarded**
by `scoutMediaResults`, which re-sorts everything on title score — reproduced live, a 640×427
did land ahead of a 1920×1280. The skeptic correctly downgraded the harm (the AI referee sees
REAL probed pixel dimensions, and the vision rubric caps visibly-soft footage at 4, below the
accept floor of 6 — so a soft still can't be *accepted*), but the ordering the user explicitly
chose ("push small photos to the back so a bigger one wins whenever one exists") wasn't being
delivered. FIX: `_reserveUndersizedTail()` re-applies the split AFTER every title ranker, on
both the main and retry paths. Stable partition — ranker order is fully preserved inside each
group, no-op unless the list actually mixes both, images-only (`isTooSmall` returns false for
video and for unknown dimensions).

**Fifth defect, found by hand after the fact** (the crash/scope lens died on its 4th restart and
never returned a verdict, so its scope was covered manually — `node --check` across all 77 changed
+ 22 new JS files, and every call site of every changed signature grepped; all clean). `_tiebreak`
had the *same* zero-evidence shape as #1: it checks the clock once up front, then fires a strict
`_ask` per tied video, and on a falsy hit halves a **genuine** `present:true` confidence. If the
deadline expired in between, that halving was applied for a question never actually posed —
demoting a confirmed video under another confirmed one. FIX: `if (!hit && !answers.asked) return;`
— no looks, no opinion, same rule as everywhere else in the file. Band is unaffected either way
(`present` stays true), so this was ordering-within-band only, hence "bounded".

Verified: 12/12 probe assertions (null-signal runs / real abort still cancels / failed attempt
not cached / cache split asserted on source / out-of-time = no opinion / phantom verdict not
remembered / screening slot handed back / nothing spent / real negative still reported with
matching call count / real verdict cached / positive verdict intact / no-deadline path
unchanged), plus `npm run verify` 23/23 and a module-load check.

### Fix #9 — INVESTIGATED, DELIBERATELY NOT CHANGED (render-time authored-comp gate)

A post-hoc audit flagged the **new, uncommitted** render safety gate at
`src/render/hyperframes-bridge.js:2436-2453`. It re-runs `validateComposition` against
`authoredDuration = Math.max(timing.duration, timing.sourceDuration)`, which is clamped by
`maxVisualDuration` (overlay ⇒ **5.8**), the scene window and overlap shrink — while the author
was briefed with `composition-author.js:visualDurationSeconds`, clamped only to `[1.2, 20]`.
Two different numbers, so a correctly-authored comp can be thrown away at render. `duration`
drives **exactly one** check in `validateComposition` (hf-template-author.js:331-333, maxEnd vs
duration); every other check ignores it (whole body 236-378 scanned).

Proposed fix was a one-argument call-site change (pass `Infinity`, never `null` — `Number(null)`
is `0` and IS finite, which would reject everything). **Rejected 3/3 by independent refutation
lenses, and NOT applied.** Reasons, in order of weight:

1. **The frequency measurement it rested on was wrong.** The claim "0 rejections on every plan on
   disk, including the live project" is false — `applyVisualTimingGuards` returns `{graphics,
   report}` and does **not** mutate its input, so measuring the input array reproduces a phantom
   zero. Using the return value: the live plan has **17 authored comps and 1 real rejection** —
   `auth-headline-76ab80` (motionGraphics[2], overlay/headline, start 27.92s, `mg.duration` 8.9
   clamped to 5.8, comp maxEnd 8.56). Confirmed independently by hand.
2. **The fix would make that one graphic WORSE.** Today it is rejected and falls to the generic
   headline renderer, which draws a *complete* in/hold/out sized to the 5.8s window. Admitted, the
   bespoke comp is force-hidden at 5.8s while all four words sit at opacity 1 in a mid-hold —
   guillotined at **67.8%**, 2.76s of choreography never plays. Task framing was "stop throwing
   away AI graphics"; the fix instead shows one broken.
3. **`Infinity` deletes the check unconditionally**, including for the 26 historical comps that
   overrun their OWN briefed duration — the population the proposal explicitly claimed not to
   touch. Measured: 24 of 26 flip reject→accept, overruns up to +1.92s.
4. **Render length is NOT capped by `data-duration`.** `node_modules/hyperframes/dist/cli.js`
   derives `getDurationFrames` from `timeline.totalDuration()`; `data-duration` only pads *up*.
   A tail comp therefore lengthens the MP4 (measured 600.000 → 601.620) and the CLI silence-pads
   the audio to match. Visibility is contained (the emitter always hard-hides the container at the
   window end) but **length is not**.
5. `HF_TEMPLATE_AUTHOR=0` / `HF_AUTHOR_OVERLAYS=0` / excluded types / a swallowed throw in
   `runCompositionAuthorPass` all skip the author-side checks, and the bridge greps clean for those
   flags — so in those states this gate is the only duration bound left.

**Decision: leave `hyperframes-bridge.js:2442` alone.** The asymmetry is real and reachable, but on
the plan about to be rendered the current behaviour produces the *better* output. If it is ever
closed, pass a **bounded** value (the author-side `visualDurationSeconds(mg)`), never a non-finite
sentinel. Note `authoredDuration` is also consumed at 2617 (`normalizeAuthoredTimeline` — measured
behaviourally sensitive: injects a seek-safe hard-kill at Infinity but not at 5.8), 2620 and 2632,
so widening the variable itself is *not* behaviour-preserving.

Separately flagged, not fixed: ~16% of pre-existing authored comps (26/166) overrun their own
briefed duration and now fall through to the generic renderer. Independent of which number the
bridge passes. No verify script asserts this gate in either direction
(`scripts/verify/overlay-transparency.js:171` asserts only that authored comps DO render, and
passes either way).

### Fix #10 — SHIPPED: permanent fix for the render-blocking same-lane clip collision
User hit `Render Failed — Motion QA blocked a broken render: Track 509: clip ending at 133.7s
overlaps with clip starting at 133.58s` and asked for a **permanent** fix.

**Root cause — an address-space contradiction between two functions that never see each other.**
`allocateGraphicTrack()` (`hyperframes-bridge.js:2373`) hands out **consecutive** lane numbers
(`500 + order` fullscreen, `1000 + order` overlay). `renderAssetFill()` (:2213) parked a graphic's
background media on `Math.max(0, track - 1)` — which **IS the previous graphic's wrapper lane**, by
construction. The template `preRoll` then starts that background **0.12s earlier** than its own
graphic, reaching back into the neighbour's window. Consecutive stage visuals are normally
butt-joined, so the collision is the **rule, not the edge case**.

**Why it surfaced only now:** a background tag is emitted only when `isFull && !transparentTemplateBg`,
and the graphic drops to the bg-owns-the-lane path only when its asset `isVideo` and no authored comp
renders. Replacing the project's media with real YouTube **video** finds (Fix #8 / task #8) flipped
three graphics onto that path. Two earlier generations of the *same* project emitted **zero** bg tags
and rendered clean; the third emitted three and blocked. Same plan, different outcome — stochastic.

**The fix** (`hyperframes-bridge.js:2210-2233`): backgrounds get their own reserved band,
`BG_MEDIA_TRACK_FLOOR - Math.max(0, Math.floor(Number(track) || 0))` with the floor at `-100000`.
**Disjoint by construction, not empirically:** every other emitter in the file is `>= -10000`
(scene media floors exactly there; captions 26, transitions 28, voiceover 30, sfx 31+i, wrappers
500+/1000+), the bg band is `<= -100500`, and the two bands grow in **opposite** directions — no plan
size, graphic count or sfx count closes the 90,000-lane gap. Uniqueness within the band holds because
`buildMgMarkup` has exactly one call site passing the `forEach` index, so `track` is injective.

**Why this and not the obvious alternatives.** Striding the allocator (`base + index*2`) renumbers
every graphic lane and **halves** the dormant fullscreen→overlay headroom (501 graphics → 251).
Dropping the pre-roll deletes a real rendered effect and leaves all 103 historical pairs at *exactly*
0.000000s separation, surviving only on the 1e-6 epsilon. Fixing it in Motion QA is impossible as
built: the CLI emits this finding with **empty** `selector` and `elementId`, so `diagnosticEntryForFinding`
returns null and the repair loop `continue`s — and Motion QA has no primitive that changes a track index.

**Safe because the lane number is inert bookkeeping.** Verified three ways: the CLI runtime keeps
`track` and `zIndex` as separate manifest fields and reads z from inline CSS; `window.__clipManifest`
is never read back on the Node/capture side; audio mixes by **array index** (`mixAudioTracks`), never
by track. Stacking here comes from static CSS (`.hf-bg-media` z-index:30 under `.hf-mg` z-index:40)
plus DOM order. The `trackIndex === zIndex` sites in `cli.js` are HyperFrames **Studio** authoring
code this repo never invokes — we hand the CLI a finished HTML file.

**Proven end-to-end on the real failing plan**, not simulated: regenerated
`video-plan.snapshot.json` from the failing render through the patched bridge — 74 timed clips both
sides, same 3 background tags, lanes `505/509/513` → `-100506/-100510/-100514`, overlap pairs
**1 → 0**. Real CLI lint (`node node_modules/hyperframes/dist/cli.js lint <dir> --json`, v0.7.64):
`ok=false errors=1` (the exact shipped message) → `ok=true errors=0`, with the same 2 pre-existing
warnings and **zero** new findings of any severity. No `invalid-track-index` (negative integers are
legal — `readTrackValue` only requires `Number.isInteger`), no `timeline_track_too_dense` (each
background gets a private lane, so density goes **down**). `npm run verify` 23/23.

**Regression lock added** to `scripts/verify/hyperframes-bridge-smoke.js` (the repo's only reader of
`data-track-index`): a global same-lane overlap scan mirroring the CLI rule at its exact 1e-6 epsilon,
plus a structural assertion that every `hf-bg-media` lane stays below `-10000` and that no two share
one. **Confirmed a live lock** — reverting the bridge fix makes the smoke test fail with
`graphic background media left its reserved lane band`. The new global scan also covers the shared
caption lane 26, which no built project in the corpus had populated.

**TRAP for future work:** the value must stay an **integer**. The CLI's `readTrackValue` silently
rewrites a non-integer to lane 0, which would merge the clip into an unrelated overlap group instead
of erroring. The old formula emitted the literal string `"NaN"` for a NaN track; the new one is
guarded and strictly more robust on degenerate input.

**Residual, closed by Fix #11 below:** transitions all shared hardcoded lane 28 and captions all
shared hardcoded lane 26.

### Fix #11 — SHIPPED: closed the last two shared lanes (captions + overlay transitions)
Completes the class Fix #10 opened. `src/render/hyperframes-bridge.js` + the smoke test.

**Root cause, two independent mechanisms feeding one lint group each.**
- *Captions (LIVE — blocks renders today).* `buildCaptionCues` pads any cue shorter than 0.4s UP to
  0.4s (`Math.max(0.4, end - start)`) and does **not** move the next cue's start. 94.5% of real
  WhisperX inter-word gaps are exactly 0s, so the pad has nothing to eat into. `flush()` fires at
  scene boundaries and on `/[.!?]$/`, so a scene ending on a short word becomes a padded cue that
  runs into the next scene's first cue. Proven on the real 47-scene plan
  (`video-plan.BACKUP-before-yt-replace.json`, 523 real words): scene 14 ends on "round" spanning
  0.360s, padded to 0.400s, scene 15 starts at exactly 78.02 → real CLI error
  `Track 26: clip ending at 78.06s overlaps with clip starting at 78.02s`. Base rate ≈ 2 of 10
  narrations. The CURRENT plan passes at a worst-case margin of **0ms** — knife edge, not safety.
- *Transitions (latent).* An overlay transition is CENTRED on its cut, spanning `[B-d/2, B+d/2]`,
  `d = clamp(0.34, 0.75, … ?? 0.46)`. Two collide iff `B2 - B1 < (d1+d2)/2`. The BUILD path is clean
  (59-plan corpus, 798 boundaries, 10.4% emit rate, min gap 1.600s). Reachable only via
  `cutClipAtPlayhead` (F key, `ui/js/app.js:3662`), which deep-clones the scene at `:3670` so the
  right-hand piece INHERITS the transition.

**The fix — one private lane per clip, not a shared lane per family.** New reserved origins beside
`BG_MEDIA_TRACK_FLOOR`: `CAPTION_TRACK_ORIGIN = -5000000000`, `TRANSITION_TRACK_ORIGIN = -5000000001`.
Captions emit `CAPTION_TRACK_ORIGIN - 2*cueIndex` (EVEN), transitions `TRANSITION_TRACK_ORIGIN -
2*overlayIndex` (ODD). `cueIndex`/`overlayIndex`, not `i` — the caption map body already binds `i` in
the karaoke word loop. Nothing else changes: no timing, no text, no CSS, no DOM order. Restamping the
lane is the ONLY lever in bounds — moving TIMING would drag captions off their words and transitions
off their cuts, which is an editorial change.

**Why it is structural, not lucky (4 parts).** (1) Parity: captions always even, transitions always
odd — holds at any count. (2) Within-family uniqueness comes from the `map()` index. (3) vs every
unreserved emitter: those are all ≥ -10000; both origins are below -5e9 and only decrease. (4) vs the
bg-media band: that floor is `-100000` minus a graphic wrapper track `500|1000 + order`, where `order`
is a JS **array index**; ECMAScript caps array length at 2^32-1, so the deepest lane it can EVER reach
is `-100000 - 1000 - 4294967294 = -4295068294`. Both origins sit 705 million lanes below that — a
**language-level** bound with no ceiling on plan size.

**End-to-end proof (real plans, real CLI, A/B both directions).**
| | BEFORE | AFTER |
|---|---|---|
| 47-scene, subs ON | `ok=false`, 6 findings, **ERROR** `overlapping_clips_same_track` "Track 26…", 2 density warnings | `ok=true`, 3 findings, all warnings |
| current plan, subs ON | `ok=true`, 7 findings, 1 density warning | `ok=true`, 6 findings |
| lanes (47-scene) | 190 clips on 88 lanes, 2 shared, 1 overlap | 190 clips on **190** lanes, 0 shared, 0 overlaps |
| lanes (current) | 154 clips on 73 lanes, 2 shared | 154 clips on **154** lanes, 0 shared |
AFTER is a strict SUBSET of BEFORE in both cases — zero new findings at any severity — and
`timeline_track_too_dense` stops firing because each lane now holds one element.

**Regression lock** (`scripts/verify/hyperframes-bridge-smoke.js`, ~125 lines after the
`secondResult` block): a third fixture plan that reproduces BOTH mechanisms in miniature — a 0.15s
`"Go."` cue padded to 0.4s against a next cue at 0.20s, and two `flash-white` overlays 0.25s apart
with d=0.46. Four vacuity guards assert the fixture still reproduces the bug before the lane
assertions run. **Negative-tested both halves live**: reverting captions to 26 fails with
`two caption clips share a lane…`; reverting transitions to 28 fails with the transition equivalent.
`npm run verify` = **23/23** with the fix in.

**Adversarial review — 3 lenses, 0 refutations.** *Arithmetic/reachability*: brute-forced 40+
degenerate inputs, 3M indices, a 6× scale plan (594 cues / 239 transitions), and re-ran the positive
control — merging two cues back onto one deep lane makes the CLI print
`Track -5000000062: … overlaps …` verbatim, so the magnitude is honoured end-to-end and the clean
result is real. *Completeness*: independently enumerated all 8-9 emit sites; found the disclosed
"scene media self-collides at >1000 clips" residual is actually **unreachable** because
`parseTrackIndex('video-track-1')` → `"--1"` → NaN → fallback 0, so base is always 0.
*Render-path regression* (the lens that died and was re-run): all 7 diagnostics sidecars
BYTE-IDENTICAL; `keyframes --runtime all` byte-identical (hash `484dafb830bc6f4b1afb66fd75cebe7d`);
0 non-track HTML differences in BOTH render and preview mode; **pixel-diffed real captured frames**
with a CUR-vs-CUR control proving the only 2 differing frames are capture nondeterminism (control
delta 532px > CUR-vs-NEW delta 135px).

**The one real hazard found, and why it is closed.** `getZIndex(el)` in the HyperFrames CLI literally
`return timing2.trackIndex` — the CLI DOES treat the track as a z-index in exactly one place. Traced:
its single call site is inside `parseHtml(html)` (the Studio element-model parser), whose only real
consumer is the **`info`** command. This repo invokes `snapshot`/`lint`/`keyframes`/`check`
(`motion-qa-agent.js:1149/2202/2215/2229`) and `render` (`main.js:4104`) — **never `info`**. A sweep of
all 65 `trackIndex` occurrences in `cli.js` found no track-based sort anywhere in the capture or
compositing path, and the injected page runtime's 2 `trackIndex` hits are a frozen attribute-name map
and a defined-but-unused required-attribute array. Confirmed by the pixel captures above.

**Repo-side readers:** the ONLY reader of `data-track-index` in the whole source tree is the smoke
test. Nothing in `ui/js/`, `main.js`, Motion QA, or the generated page's own JS reads it. The
preview runtime (`~:5247`) selects clips by CSS **class** and reads only `start`/`duration`/
`mediaStart`. Stacking is a fixed CSS constant (`.hf-transition` z-index 80, `.hf-caption` 60), so the
lane cannot affect what is on top.

**Accepted residuals.** (a) `hyperframes info` — never invoked here — would print ~154 tracks instead
of ~73; cosmetic, and the same consequence Fix #10 already accepted. (b) A hypothetical FUTURE
consumer applying int32 bitwise coercion (`track|0`) would fold -5e9 to -705032704; lanes stay
distinct but magnitudes scramble. No such coercion exists in the shipped CLI or page runtime.
(c) Untouched positive-lane space: sfx `31+i` vs graphics `500+order` needs ≥470 SFX; fullscreen
`500+i` vs overlay `1000+j` needs ≥501 graphics AND time overlap, which the time-sorted `graphics`
array makes impossible.

**Maintenance note:** three of the new assertions verify the fixture still REPRODUCES the bug. If
anyone later fixes `buildCaptionCues` to pad without overrunning the next cue's start (a legitimate
improvement), `npm run verify` goes red on that fixture — the assertion message says so explicitly.
Update the fixture, do not delete the guard.

### Also open, untouched
Both media passes running out of clock at the SCENE level (Reddit never ran, ~30 of 45
candidates untested) — Fix #7 removes the biggest cause but the end-to-end scene budget has
not been re-measured on a full build · media-memory-bank keeps a 2nd full copy of every
accepted master · scene 43's unfindable conjunction · `temp/` in the test project measured
at 2.4 GB (noted, uninvestigated).

**Correction to an earlier claim in this file:** the storyboard fetch is **NOT** "100%
failing". Tested end-to-end this session on a real video: it fetched, parsed 3 sheets / 75
frames and returned a genuine verdict. The evidence behind that claim was never in the 12
newest project logs (none of them contains the word "storyboard" at all). The real defect was
the unenforced deadline, now fixed above. Likewise "screening asks the same question 3× in
parallel" is UNCONFIRMED — the three calls are three DIFFERENT contact sheets that happen to
tokenize to the same length. Do not repeat either claim without fresh evidence.

## LATEST — July 6, 2026: docs + memory resynced to code
User asked to sync all docs with the codebase. Done, verified against actual files:
- **CLAUDE.md fully rewritten** to match reality: render engine is the
  **HyperFrames Bridge** (`src/hyperframes-bridge.js` → `hyperframes` CLI,
  captured via chrome-headless-shell in main.js), NOT WebGL2/FFmpeg. The
  `ffmpeg-renderer.js` + `canvas-mg-renderer.js` files are GONE; the WebGL2
  compositor (`ui/js/compositor/`) is legacy in-app preview only. Documented
  the 20-step build pipeline, the editor-agent CEO + 11 workers, the media
  subsystem, 8 themes, ~18 niches.
- **AI brain architecture changed** (new since the June-12 log below): text =
  **AWS Bedrock base** (deepseek.v3.2 default) + **hybrid brains beside it** —
  AiLink (GPT-5.5), APlink (Claude relay), Azure Claude, Azure OpenAI. **Grok
  is BACK** — served via the Azure OpenAI-compat endpoint (`config.azureOpenAI`,
  grok-4.3), NOT Vertex (the "Grok abandoned" note below is superseded).
  Vertex/Gemini (`vertex-auth.js`) now powers ONLY Style Studio / QA / Style
  Learner. Vision unchanged: Qwen-VL (self-hosted) → Bedrock fallback,
  selected by `VISION_BACKEND`.
- **Memory updated:** new `project_brain_architecture.md`; MEMORY.md index
  compacted (was ~23KB → ~14KB) + stale one-liners fixed (themes 5→8, vision
  chain, explainer.politics, Grok status); `project_removed_disabled.md` gained
  the FFmpeg/canvas-renderer + deleted-provider removals.
- No open task was in flight; this was a documentation pass only. The June-12
  build-feature history below remains accurate as history.

## Who/what
Solo dev building a VidRush-class faceless-video platform (this repo).
Render engine: **HyperFrames Bridge (HTML/MG)** — HTML+GSAP compositions,
captured frame-by-frame by the hyperframes CLI. Test project:
`C:\Users\user\Downloads\Mps Fixing` (Red Sea/shipping niche, ~38 scenes).

## Working protocol (MANDATORY — user-mandated)
Fix → self-review → verify on the REAL pipeline (generate the actual HF
project) → SCREENSHOT PROOF shown to user → check upstream decisions (VP/
Director/briefs) → anything off = root-cause + fix siblings → re-verify.
Screenshot tooling: headless Chrome on generated `index.html`
(`window.__timelines['yta-hyperframes'].time(t)` then screenshot), ffmpeg
frame-extraction from MP4s, PrintWindow for the live app, DevTools port 9223.

## What was built June 10–11 (all verified with screenshots)
1. **Map system (GEOLayers-grade)** — `src/map-hf-builder.js` wired into
   `hyperframes-bridge.js`: real MapTiler basemaps, hi-fi OSM borders
   (threshold 0.00008, cap 22k pts), cartography stack (casing + 1.8px core +
   inner glow band 14px/0.20), zoom-adaptive labels (ZOOM_ADAPT k=0.35 via
   overlayScaleFor — icons later plug in here), camera zoom cap 2.0,
   mainland-framing (largest ring only), 3D pitch (rotationX tilt wrapper,
   route 9° / region 15°), draw-on animations. Verified on Spain vs GEOLayers.
2. **Agent-authored compositions** — templates + fullscreen MGs authored as
   bespoke HTML/CSS/GSAP by Sonnet (taskType=brain) via skill pack
   `skills/hyperframes-template/` + `src/hf-template-author.js` (textual lint
   + numeric whitelist [facts must come from brief] + `src/hf-visual-lint.js`
   rendered-pixel checks [overflow/overlap/invisible] + repair round + cache
   `.hf-authored-cache.json`, AUTHOR_VERSION v7). Runs in build Step 7.6 +
   render-prep. Overlay MGs stay on legacy path (user decision).
3. **Effects system** — `src/hf-effects.js` animated registry (grain/leak/
   flicker/vignette/bloom/chromaticEdge + 6 grades; letterbox REMOVED) +
   `effects-director.js` (1 batch brain call → scene._effectRecipe, cached
   `.hf-fx-cache.json`). Edge effects banned on framed clips (FULLFRAME_ONLY).
4. **Render-quality fixes** — video data-start (static-noise bug), @font-face
   embedding (16 woff2 in assets/fonts), backdrop coverage rule (any scale<1
   gets blurred-media backdrop; flat bgs tint OVER media blur), Ken Burns
   coverage (fromScale 1.06), preview centering (margin:auto + body grid).
5. **Footage fixes** — stock-query entity sanitizer (VP `_sanitizeStockQuery`),
   vision score-retry (ai-vision.js strict retry — was 30 unjudged/build),
   clip-analyzer Omni strict retry (was 11 parse fails/build), sanity-bump
   guard (maps/charts/labels never rescued), topic-map rescue demoted 7→5.
6. **Infra** — HF project dirs auto-pruned (keep 3), workers default 4,
   ENOSPC root-caused (C: was 0.6GB free), DevTools port 9223 in main.js.

## Current state (June 11 evening)
User just FINISHED A FRESH BUILD of Mps Fixing — the first with ALL fixes.
**NEXT TASK: full verification vs this scorecard** (log audit + screenshot sweep):
- Direct footage: was 17/25 → expect higher
- vision "unjudged": was 30 → expect 0 | Omni parse fails: was 11 → ~0
- map-image/heatmap B-roll: expect 0 | letterbox/black-box artifacts: 0
- media phase: was ~36min → expect shorter | maps: new system everywhere
Logs: `C:\Users\user\Downloads\Mps Fixing\logs\app-*.log` (newest).
A background watcher may have already flagged completion.

## Build verification June 11 night (DONE): direct footage 24/30 (was 17/25), unjudged 0 (was 30), Omni parse fails 0 (was 11), sources video-dominant, maps 7/7, author 23/25. HUMAN-EDITOR fixes applied post-audit: (1) rejectedAll marker — Omni all-frames rejection now KILLS the candidate instead of heuristic-trimming it in (clip-analyzer.js + youtube-video.js; was how TOI burned-banner clip shipped); (2) low-res/upscaled footage → MAX 4 rubric penalty (ai-vision.js). OPEN from sweep: empty frame moment at ~t=160 (dead air — uninvestigated); scene-frame overflow clipped (grain box == footage box now); stage-visual scale-in takeover entrances (user testing).

## Graphics balance (June 11, late): plan analysis showed templates 54% + maps 25% = 79% runtime coverage, footage visible 22% — inverted editing. ROOT: VP section-16 template triggers fire on every number/place/quote with no counterweight, and Editor-Agent mode preserves all hints. FIX (user mandate: NO hardcoded caps — agent judgment only): hardcoded budget REVERTED; added FOOTAGE-FIRST EDITORIAL JUDGMENT block to VP prompt (templates must EARN slots, no back-to-back graphic scenes, passing-mention numbers = footage + overlay, footage is the backbone). Verify next build: footage-visible share should rise sharply; if VP still over-hints, strengthen prompt further — never add caps.

## LOOK HUMAN rule (June 11, late night): user banned eyebrow/category labels
("• KEY TAKEAWAY", "• KEY CHOKEPOINT") on stage visuals — "all motion graphic
shit should look human not ai". Fixed globally, 3 layers: (1) SKILL.md hard
content rule (no meta-labels, every text element must tell the STORY not
describe the GRAPHIC); (2) brief no longer passes kicker (composition-author)
+ KICKER prompt line removed + generic lint rejects on-screen type-tag text
(hf-template-author, AUTHOR_VERSION v8-human-not-ai — full re-author on next
open); (3) legacy path: templateKicker + buildAgenticMarkup gated by
isStageVisual (person-intro exempt — its label is a real role; overlay MGs
untouched). VERIFIED: 4 keyTakeaways re-authored via real worker, screenshots
clean. SIBLING BUG found+fixed during verify: gsap was CDN-only — visual lint
ran with NO gsap (initial-state measurements wrong). gsap@3.14.2 now a
devDependency; lint measures real frames.

## Media asset pipe v9 (June 12): authored comps can now USE REAL IMAGES.
User showed VidRush-style examples (subject photo + animated callouts,
sketch charts) — gap was `assets: []` (author was media-blind). Now:
composition-author resolves up to 2 images per brief (mg's own media, else
owner/nearest footage scene within 12s, images only) as `__HF_ASSET_i__`
tokens + desc; prompt/linter token-aware; bridge substitutes real copied
paths at render (missing used asset → fixed-renderer fallback);
mg._authoredAssets persists. SKILL.md media playbook: subject board (photo
panel + callout cards + connector draw-ons), photo panel w/ Ken Burns,
blurred backdrop, cover-fit + scrim rules; house-style: connector pattern +
chart-build pattern (axes draw → bars grow → count-ups). AUTHOR_VERSION
v9-media-assets. VERIFIED on real plan: 17/25 briefs carry an image;
stat-card (8-9M barrels over real ship aerial) + comparison-card (VS split
over darkened gulf aerial) authored + screenshotted clean. Videos as
authored assets = future work (needs runtime seek-sync).

## Subject-image fetch v9.1 (June 12): asset-less authored beats that NAME a
Director-tagged entity now fetch ONE subject photo on demand.
`src/subject-image-fetcher.js` (Bing→Brave via live providers, base-provider
floors + PNG sanitize, deterministic cache `public/authored-assets/
subject-<slug>.png`) + `enrichBriefsWithSubjectImages` in composition-author
(entity picked from scriptContext.entities matched in the beat's own text,
ranked person>org>event>place; abstract beats correctly stay designed-bg;
HF_AUTHOR_SUBJECT_FETCH=0 disables). VERIFIED live: Houthi-forces quote-card
fetched a clean parade photo and authored a split quote+photo-panel comp
(screenshot shown). Needs user rebuild/reopen to land project-wide.

## Entrance guard v10 (June 12): user caught frame-0 of authored comps
showing the FINISHED layout (GSAP fromTo doesn't apply "from" until first
render). Fixed 3 layers: (1) bridge primes every authored timeline
(`tl.progress(1,true).progress(0,true)` before master.add) — fixes all comps
deterministically; (2) hf-visual-lint primes too + new t=0.03 check (all
text fully visible at t=0 → "no entrance animation" rejection into repair);
(3) SKILL.md contract: timeline must OPEN with gsap.set initial states.
AUTHOR_VERSION v10-entrance-guard. VERIFIED via re-rendered trump-demo.mp4
(frame 0 black/backdrop-only, entrance builds). ENTRY-ANIM AUDIT: legacy
templates/fullscreen/overlay MGs = hfEnterState takeover + graphicAnims ✓;
maps = explicit gsap.set initial states ✓; effects = ambient loops (no
entrance by design) ✓. Authored path was the only hole.

## Transition system v2 (June 12): replaced the lazy slab-only system.
(1) RUNTIME (hyperframes-bridge): scene-MOTION engine — push-l/r/up, wipe-l/
r/up (clip-path), whip-l/r (xPercent+blur), zoom-punch/pull, blur-dissolve,
spin-settle animate the ACTUAL scene containers; overlay slab kept only for
flash-white/dip-black/light-sweep/glitch. canonicalTransitionType now
direction-preserving; collectTransitionOverlays emits mode:'motion' items
with outId/inId (adjacent footage) or incoming-only when graphics precede.
BUG FIXED during verify: loop started at i=1 — first footage scene's
boundary was silently dropped whenever the video opens with graphics.
(2) BRAIN: src/editor-agent/workers/transition-director.js — 1 batch brain
call sees the FULL visual sequence (footage+templates+maps), assigns
motivated transitions per boundary (cut = default, ~25-35% visible budget,
signature-set consistency, location→whip, time→dissolve, reveal→zoom-punch,
act break→dip-black ≤2). Writes scene.transition {type,duration,reason} —
same contract as algorithmic pass (which stays as floor). Cache
.hf-tx-cache.json, HF_TRANSITION_DIRECTOR=0 disables. Wired into
authorPlanCompositions next to FX director.
VERIFIED on real Mps Fixing plan: 8/8 boundaries decided with editorial
reasons (6 visible), real project generated, 4-boundary MP4 demo rendered
(.tmp/map-test/transitions-demo.mp4) — blur-dissolve + dip-black + punches
confirmed on rendered frames.

## Overlay MGs → authored path (June 12): the last MG family converted.
composition-author now collects plan.motionGraphics as kind 'overlay'
(OVERLAY_EXCLUDED: listicle-counter/subscribe-cta/progress-tracker/caption;
HF_AUTHOR_OVERLAYS=0 reverts). Overlay briefs: NO assets (footage is the
image), position zone passed + hashed. SKILL.md OVERLAY MODE: transparent
stage, coverage ≤~30%, anchor in position zone, tight plates/shadows only,
smaller type, 1-2 elements, ≤0.45s entrance. hf-visual-lint overlay checks
(grid coverage >32% reject, single painted element >62% frame reject) —
negative-tested: full-frame scrim and oversized plate both rejected, clean
lower-third passes. Bridge: authored block accepts overlays,
data-hf-authored-overlay attr breaks container out of pos-* boxes
(inset:0, transform-locked), container enter is opacity-only (authored
timeline owns motion); mg._authoredRendered flags markup success for the
runtime. VERIFIED: real kineticText + synthetic lowerThird/statCounter
authored over real footage frame — broadcast-grade plates, footage stays
the star. Legacy agentic-spec path remains the fallback floor.

## Variety v11 (June 12): user rejected same-silhouette convergence ("i need
the agent to be creative... beautiful variants"). No fixed variants exist —
problem was model habit (every comp = dark plate + accent rule). Fix:
(1) SKILL.md VARIETY section — same-silhouette = failure mode, inspiration
repertoires for stage + overlays (frosted glass, bare shadow-text+underline,
pill badge, bracket frame, leader line, oversized numeral, ticker strip…),
"vary STRUCTURE/MOTION, never the palette"; (2) STYLE LEDGER — each comp's
fingerprint (kind/type/notes) accumulates during the batch; later briefs see
siblings' treatments + hard rule: 2+ plates already → MUST use different
construction. Seeded from cache hits; concurrency means first ~3 are blind.
AUTHOR_VERSION v11-variety. VERIFIED (5 sequential overlays): comps 1-3
plates, comp 4 varied accents/numeral, comp 5 broke silhouette entirely
(bare shadow-text + draw-on underline) — mechanism works, diversity grows
with ledger depth.

## Background packs (June 12): stylist scene backgrounds, ONE per video.
src/hf-background-packs.js — 7 theme-token-tinted CSS packs (studio-gradient,
spotlight, dot-matrix, blueprint-grid, paper-grain, bokeh-drift, split-tone),
each with slow GPU-friendly motion. Duplicate-blur backdrop stays the
universal default lane ('blur' scenes unchanged); scenes with FLAT background
choices (gradient:x/soft-x) now render the VIDEO's pack instead of generic
tints. Selection: effects director picks "videoBackground" in its existing
batch call (validated, cached in .hf-fx-cache.json → plan._hfBackgroundPack);
fallback = theme default map (crime→spotlight, history→paper-grain,
modern→dot-matrix, minimal→split-tone, standard→studio-gradient).
HF_BACKGROUND_PACKS=0 reverts to legacy tints. VERIFIED: real generation
(pack resolved+rendered+CSS injected, log line "[HyperFrames] Background
pack: …") + 7-pack gallery behind a framed clip; first pass was too subtle —
alphas/vignettes retuned for clear visibility. Future: UI dropdown override,
DESIGN-doc echo into authored comps.

## Explainer icons (June 12): word-synced animated visuals over footage.
src/editor-agent/workers/icon-director.js — 1 batch brain call reads footage
narration + Whisper word timings, assigns SPARSE icon moments (~quarter of
scenes max): kind "photo" (concrete things → web photo, watermark-filtered →
@imgly bg removal → transparent PNG; Storyblocks fallback) or "svg" (abstract
concepts → director-authored pictogram, strict sanitizer: shape tags only,
viewBox, currentColor, no scripts/links; QUALITY BAR: stranger names it in
1s). CUTOUT QUALITY GATE (canvas alpha measurement: solid 5-70%, bbox ≥25%)
rejects bg-removal ghosts — drops the moment rather than shipping garbage.
Bridge: icons render INSIDE scene wraps (travel with transitions), pop in
back.out on the trigger word, float, exit; theme-accent currentColor; 6
corner/side positions, never center. Cache .hf-icon-cache.json;
HF_ICON_DIRECTOR=0 disables. VERIFIED real pipeline: warning-triangle +
route pictograms clean; watermarked-ghost case caught by gate (subject
fetcher now also rejects watermark domains globally — benefits subject
photos too). THIRD KIND added same day: "image" — whole photograph kept
(no cutout), rendered as a small framed picture card (400×270, white
border, -1.6° tilt, shadow) for places/events/people/documents; verified
via real bridge render.

## Perfectionist mode v12 (June 12): the authored loop now SEES its work.
After lint passes, hf-template-author captures the hero frame
(captureHeroFrame in hf-visual-lint) and the VISION chain reviews it as an
art director: "APPROVE" or "REVISE: ≤3 concrete visual fixes" (hierarchy,
balance, alignment, AI-tells; never copy/facts). On REVISE: one refine round
with the critique + previous output; refined version must re-pass ALL lints
or the original ships (no regression). HF_AUTHOR_PERFECTIONIST=0 disables.
Cost: +1 vision call per comp, +1 author call only when revised.
AUTHOR_VERSION v12-perfectionist. VERIFIED live: both test comps got REVISE
(headline scale + left-align notes), refined cleanly — "BACKUP ROUTE" became
a left-aligned typographic poster with drawn arrow; "ANOTHER CHOKEPOINT"
became a left-aligned editorial layout over real footage with corner
brackets. This closes the "Claude Code can look at its result" gap.

## Rebuild diagnostic (June 12, log app-2026-06-12T11-32-52): user's first
full build with the entire stack. HEALTHY: FX 15/15 + blueprint-grid
(director-chosen), transitions 15/15 decided → 10 visible rendered (match),
icons 3 decided → 3 rendered (match), maps 8/8, art director 1 approved /
16 revised / 1 kept (review bites), lints caught fabricated 1869/7000/80 +
no-entrance + overlap (3 comps correctly fell back). BUGS FOUND + FIXED:
(1) authored OVERLAYS never rendered — the agentic-spec early return in
buildMgMarkup came BEFORE the authored block; moved authored to highest
priority; regen verified 15/15 rendered (was 12). (2) DOUBLE-AUTHOR per
build — ns embedded the candidates array INDEX; post-build plan mutations
shift indexes → render-prep cache misses (18+11 calls). ns now
content-hashed (auth-<type>-<sha6>), dedupe for identical briefs. One-time
cache bust. (3) BURNED-BANNER clip shipped (scene 5): referee SAW "visible
news graphics ('13' logo)" and picked it anyway over a clean 7/10 carrier
clip; post-download scorer also gave 7/10 while describing the defect.
Fixed: clampSelfReportedDefects in vision-score-sanity (description admits
broadcast packaging → score capped 4, deterministic, unit-tested incl.
negations) applied in applyMediaHunterFrameGate; HARD DEFECT RULE in
candidate-referee prompt (clean beats defective regardless of subject
match). (4) Author fabricated source line "Suez Canal Authority · UNCTAD"
on the bar-chart — NO INVENTED ATTRIBUTIONS rule added to SKILL.md factual
safety. FIXED same day — RAW MATERIAL PRINCIPLE added to
the VP keyword rules AND the source-auditor prompt (user mandate: global,
no word lists): "a query names what the CAMERA SAW — subject + action +
setting — never the packaging/distribution form of the content; you want
the rushes, not the broadcast; dates/sources belong in overlay MGs, not
queries." Generalizes across niches (news→coverage, tech→reviews,
sports→broadcast highlights all = packaging-form queries). REMAINING
OBSERVATION: art-director revise rate ~85% (quality good, cost +1
call/comp — tune APPROVE bar if cost matters).

## CapCut-class effects library (June 12): hf-effects grew 7→17 effects +
6→9 grades, all CSS/GSAP deterministic. NEW: filmScratches, vintageFrame
(rounded ring + breathing inner fade — the user's reference look), oldTv
(scanlines+roll), vhs (RGB ghosts + tracking band), staticNoise, glitchPulse
(sparse slice bursts every ~2.2s), lightStreaks, lensFlare (anamorphic
sweep), fogDrift, embers (irregular prime-tile particles). New grades:
sepia-archival, vhs-wash, neon-night. FULLFRAME_ONLY += vintageFrame/oldTv/
vhs/lensFlare/lightStreaks. Effects-director prompt: categorized vocabulary
with use-cases + ERA RULE (era looks = signature: max ONE era family per
video, only on past/archival/flashback content, never present-day). FX
cache hash now includes vocabulary → new menu auto re-decides. Tuning
lessons: scratch/scanline alphas need ~0.7+ to read at video scale; glitch
slices must be sparse (<25% coverage) or it reads broken; particle tiles
need prime sizes + irregular dot coords or the grid shows. All 10 verified
on real footage screenshots (3 rounds of tuning).

## Map journey (June 12): user flagged 4 adjacent map scenes rendering as
separate restarting maps + camera firing instantly at entry. ROOT: the
build-video merge refused "semantic mismatch" (route vs locator vs region) —
scenes 11-14 alternated modes so nothing merged. FIX: (1) adjacent maps now
ALWAYS merge into ONE map journey (only 'comparison' refuses); per-source
windows recorded as mg._mapSegments → merged.segments ({start,end,mode,
subjects} relative to merged span) in build-video + mergeMapScenes synthesis.
(2) map-hf-builder: segments → JOURNEY camera (wide establishing SET, hold
≥0.8s, then long power2.inOut glides arriving at each segment's frame ~35%
into its narration window; frameFor() resolves subject names → pins +
largestRingBBox borders; degenerate bbox → 1.5 zoom-in); pins/borders appear
at THEIR segment start (+0.45) not global stagger. (3) slow-start pacing for
ALL maps (non-segmented too): route hold ≤1.1s then eased 3-phase;
locator/region hold ≤0.9s then one long push-in — camera never moves on
frame one. VERIFIED: real mapScene + 3 segments → keyframes correct
(0.8/3.6/7.6 arrivals synced) + 4-frame screenshot journey (wide → Bab
el-Mandeb → Yemen border draw → Djibouti reframe). Takes effect on next
REBUILD (merge is build-time; current saved plan still has the split maps).

## Template chains (June 12): template→template boundaries are now SEAMLESS
(user: "the shift between template and template unnoticeable"). (1) Bridge:
stage-visual chains detected (adjacent, gap ≤0.35s, maps excluded) →
seamIn/seamOut flags on graphicAnims; runtime: seamIn = container appears
set (opacity1/scale1, NO takeover pop), seamOut = container exit anim
skipped (holds to clamp) — internal choreography carries the swap. Applies
to authored AND legacy templates. (2) Author: chainPrev/chainNext flags on
briefs (computed across stage candidates) → CHAIN CONTINUITY prompt lines:
"next page of the same design system, calm full-frame bg from DESIGN base
colors, content entrance carries the change / exit content but keep bg to
the last frame". Hash includes chain flags. VERIFIED: 7 seam pairs flagged
on the real regenerated page; 2 chained locationCards authored — A exits to
calm canvas, B opens on matching canvas, boundary invisible (4-frame grid).
Full effect on next rebuild (chained comps re-author with continuity).

## Grok hybrid brain (June 12): user wanted Grok BESIDE Bedrock — built
hybrid routing in _getTextRoute: AI_PROVIDER=bedrock + VERTEX_TASK_TYPES=
brain → vertex:grok serves brain tasks first, Bedrock auto-fallback
(verified live incl. degradation + 120s health cooldown). FOUND: the
Google openapi endpoint REJECTS API keys → added service-account auth
(VERTEX_CREDENTIALS_FILE via google-auth-library, 45min cache, re-mint on
401; no gcloud install needed — gcloud absent on this machine). .env has a
commented template (VERTEX_PROJECT_ID + VERTEX_CREDENTIALS_FILE +
VERTEX_TASK_TYPES=brain). User must supply GCP project + SA json + enable
the xAI Grok model in Model Garden.

## Grok LIVE + UI switch (June 12 evening): Grok 4.3 answering (SA auth,
role "Agent Platform User" — console renamed Vertex AI User; key at
C:/Users/user/.gcp/). VERTEX_REASONING_EFFORT=high wired into request body.
AI Provider dropdown gained "Bedrock + Grok 4.3 Brain (Vertex)":
dropdown → set-ai-provider IPC → applyBrainProvider (live process.env +
.env persist) → routes read VERTEX_TASK_TYPES live → switch flips without
restart (verified both directions, real calls). User must SELECT the new
option after restart (settings-load syncs dropdown → env; plain bedrock
clears the hybrid).

## Theme expansion (June 12 night): user asked if graphics adapt to themes
like the video does — pipeline was fully token-driven but ALL 5 themes were
dark. Added warm-editorial (LIGHT cream/orange/serif — matches user's
reference frame), luxury (black/gold), nature (forest) + editorial-light MG
preset + validators/UI dropdown/allowlists/signal rules + LIGHT-CANVAS
support: DESIGN doc light guidance, textSecondary derives from text color
(was white-on-cream bug), bg packs use theme-derived tones (no hardcoded
near-black), THEME_DEFAULT_MAP_STYLE (warm-editorial→light basemap etc).
VERIFIED: authored bar-chart under warm-editorial reproduced the user's
reference look exactly; packs render warm cream. See
project_theme_expansion.md.

## Zero-cost opens (June 12 night): user caught ANOTHER full re-author on
open — the theme-token fix (textSecondary) shifted the DESIGN doc by one
character → design.length in briefHash → all 18 hashes busted. STRUCTURAL
FIX: OPEN MODE — runCompositionAuthorPass passes openMode:true (render-prep/
open/refresh); authorCompositions in openMode is CACHE-ONLY: hit → use,
miss → reuse newest cache entry with same content-stable ns (entries now
carry .ns; user cache backfilled 54 entries), none → fixed renderer until
next build. It can NEVER call AI. Fresh authoring = builds only (Step 7.6
passes no openMode) or HF_AUTHOR_REFRESH=1. Directors also reuse saved
plan state on open (_txDirected / _iconMoments / _effectRecipe guards).
VERIFIED: simulated hash-busting drift → stale reuse, 0 calls. ALSO from
user log: .fvp does NOT persist _authoredComposition (only the disk cache
does); Grok hit 429 RESOURCE_EXHAUSTED mid-batch (low GCP quota for xai
model — concurrency 3 bursts exceed it), Sonnet fallback covered cleanly.

## Known open items / backlog
- Icons layer for maps (plug into ZOOM_ADAPT) — completes GEOLayers parity
- Batch thumbnail pre-screening before download (biggest media-time lever)
- Overlay MGs → authored path (pending user judgment)
- FX director vision upgrade (frame-aware effect choices)
- Suez Canal (thin waterways) needs point/line OSM treatment
- Outline misses hints for last 2 scenes; sfx-blur.mp3 missing
- Utility AI calls batching (160 calls/build)

## Style/voice notes
User: direct, fast, hates waiting, wants global root fixes ("fix it globally,
not one scene"), insists on screenshot proof, all niches (no politics
hardcoding). Address findings honestly, lead with results.
