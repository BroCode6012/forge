> **CONTINUITY**: Read [SESSION-HANDOFF.md](SESSION-HANDOFF.md) first — it carries the cross-session state (current task, protocol, what was built). Transcript backups: .claude-session-backup/.

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Electron desktop app that generates faceless YouTube videos from audio narration. Uses AI to analyze scripts, split scenes, download footage, author motion graphics, plan transitions/effects, and render the final video. The final render engine is the **HyperFrames Bridge** (HTML + GSAP compositions captured frame-by-frame), not WebGL2 or FFmpeg.

## Repo State: `reorg/professionalization`

The codebase is mid-migration to an extensible platform organized around orthogonal axes. **Every file moved out of a flat `src/*.js` layout into subsystem folders.** Nothing is at `src/<name>.js` any more — check the repo map below before writing a `require`.

Migration phases (see `scripts/verify/README.md`): P0 harness → QW quick wins → P1 folder reorg → P2 settings schema → P3 format registry → P4 production-mode registry → P5 agent registry → P6 pipeline registry → GEN generation-provider registry → P7 AI Stories → P8 UI modularization.

**Done**: P0, QW, P1, P2 (`src/settings/schema.js`), P4 (`src/categories/`), P5 (`src/agents/registry.js`).
**Not done**: P3 (`src/formats/` holds only `listicle-format.js` — no registry index), P6, GEN, P7, P8 (`ui/js/app.js` is still a 13.5k-line monolith).

**THE REFACTOR RULE** (from `scripts/verify/README.md`): we only **extract / relocate / wrap / registry-ify**. We never touch a prompt string, a parse/validate/enforce body, `callAI` taskType routing, the vision chain, a deterministic floor, or a cache key. The AI smartness is the product; the reorg must be behavior-preserving.

## Commands

```bash
npm start           # Launch Electron app
npm run dev         # Launch with DevTools (electron . --dev)
npm run preview     # Same as dev
npm run build       # Run the build pipeline (node src/pipeline/build-video.js)
npm run all         # Same as build
npm run render      # (no-op) prints "Use the in-app HyperFrames renderer"
npm run start:v2    # EXPORT_V2=1 (legacy in-process-GPU export path)

npm run verify      # FULL gate: 23 checks + verify:extended. Run before committing.
npm run verify:ci   # verify + npx tsc --noEmit
npm run verify:extended   # 11 settings/registry/directive/effects/presenter/sfx/veo checks
npm run verify:runtime    # 7 checks that BOOT ELECTRON (slow, needs a display)
npm run verify:remote     # agent remote control (MCP/REST) gate, 141 checks
npm run verify:paths      # require-path resolution only (fastest sanity check)
npm run verify:sacred     # sacred-invariants tripwire only

npm run qwen-status         # Qwen vision model health
npm run qwen-sync           # Sync Qwen vision model registry
npm run storyblocks-cookies # Refresh Storyblocks cookies (visible Chrome, manual login)
npm run kling-cookies       # Refresh Kling cookies (visible Chrome, manual login)
npm run test-bedrock / list-bedrock-models / kling-collect
```

51 scripts total; 36 are `verify:*`. `npm run verify` is the contract — the reorg is only safe because these run.

## Repo Map

```
main.js            Electron main process (~7300 lines): project resolution, window lifecycle,
                   ~132 role-gated IPC channels, build child process, HyperFrames CLI render
preload.js         Sandboxed contextBridge shim. Loads ZERO app modules.
ui/                Renderer: 6 HTML pages + ui/js/ (app.js is 13.5k lines)
src/
  pipeline/        build-video.js (4.8k, 31 steps), build-orchestrator.js, transcribe.js,
                   final-review.js, pacing-verify.js, rebuild-motion-graphics.js
  brain/           ai-provider.js (callAI/callVisionAI), cost-tracker.js, strict-json.js, vertex-auth.js,
                   connections.js + connection-transport.js (AI Connections: the universal plug)
  agents/          Pipeline directors + planners (ai-director, ai-visual-planner, ceo, scene-*),
                   registry.js, base-director.js
    workers/       Brain workers (effects/transition/icon/sound/presenter directors,
                   composition-author, framing, templates, motion-qa-agent, ...)
    editor-supervisor/  In-app conversational Editor Agent (capabilities/ + workers/)
  media/           footage-manager.js (10k), media-agent/hunter/scout, candidate-*, clip-*
    providers/     Provider classes (pexels/pixabay/reddit/youtube/bing/brave/storyblocks)
                   + the generation lane (kling-*, veo-video)
  render/          hyperframes-bridge.js (5.5k) + hf-*.js authoring/effects/lint, audio-mixer,
                   mg-registry, graphic-shells, agentic-composition
  vision/          ai-vision.js prompts + GPU cost control (vision-gpu/vision-box/lightning-*)
  map/             map-assignment, map-compiler, map-provider, map-hf-builder, map-style-packs
  data/            themes.js, niches.js, languages.js, class-treatment-map.js   ← pure data
  settings/        schema.js (SSOT), config.js, build-env.js, recipe-loader.js,
                   ai-connections-store.js (encrypted connection storage)
  categories/      Category registry (faceless | talkingHead)
  formats/         listicle-format.js only (registry not built yet)
  directives/      directive-compiler + actuator + compliance-loop + presets
  project/         project-store.js, timeline-contract.js, plan-range.js
  studio/          QA Studio / QA Chat / Style Learner / Style Studio agents
  security/        safe-download.js (SSRF-hardened fetch)
  remote/          Agent remote control: tools.js (catalog) + mcp.js + server.js
                   + control-service.js + access-config.js + openapi.js
  util/            logger.js, promise.js, url-utils.js
scripts/verify/    The verification harness + sacred-invariants.json
skills/hyperframes-template/  The composition-author skill pack
```

**Empty leftover directories — do not put code back in them**: `src/providers/` and `src/editor-agent/` (+ its `workers/`) exist but contain zero files. The real paths are `src/media/providers/` and `src/agents/workers/`.

## The Four Axes

Orthogonal by design — changing one must not require touching another.

- **CATEGORY** (`src/categories/`) — the production *type*: `faceless` | `talkingHead`. The registry exports `resolveMode(raw)`, which replaced a hardcoded ternary in directors-brief. The canonical id stays camelCase `talkingHead` to match every existing `productionMode === 'talkingHead'` guard byte-for-byte. Driven by `BUILD_PRODUCTION_MODE`; unknown/empty → `faceless`.
- **FORMAT** (`src/formats/`) — `documentary` | `listicle`. Only listicle has a module; the pipeline still checks `format === 'listicle'` and delegates.
- **NICHE** (`src/data/niches.js`, 2980 lines) — content *strategy*: allowedMGs, footagePriority, pacing, searchPolicy, mapPolicy, mgRules. Two categories, ~18 niches: `explainer.*` (nature, crime, business, luxury, sport, history, motivation, food, diy, military, politics, tech) and `news.*` (politics, economy, military, celebrity, tech, sport). News niches use youtube/reddit/stock — never stock-priority.
- **THEME** (`src/data/themes.js`, 1989 lines) — **visual only**. 8 themes: `crime`, `history`, `modern`, `minimal`, `standard`, `warm-editorial` (light cream/serif), `luxury` (black/gold), `nature` (forest). Light-canvas themes supported (textSecondary derives from text color, theme-derived bg tones, per-theme default map basemap). Flow: AI Director selects → `agents/directors-brief.js` allows override → `scriptContext.themeId` → renderer + preview.

Niche ≠ theme. Each niche maps to a default theme, but the user or Director can override.

## Electron Shell & IPC (`main.js`, `preload.js`)

`main.js` is ~7300 lines — use grep landmarks, never read it whole.

**Security posture (non-negotiable)**: `app.enableSandbox()` at module load. All 6 windows use `nodeIntegration:false, contextIsolation:true, sandbox:true` + `preload.js` + `additionalArguments:['--yta-window-role=<role>']`. CSPs live in the `ui/*.html` meta tags.

**Role-gated IPC**: `ipcMain.handle` is **monkey-patched** (~main.js:140) to check `_rendererRoles` against `IPC_ROLE_CHANNELS`. Roles: `main` (everything), `startup`, `footage-resources`, `qa-studio`, `qa-chat`, `style-studio`.
- **Adding a channel takes 3 edits**: the handler, `IPC_ROLE_CHANNELS`, and `ROLE_METHODS` in `preload.js`. Miss one and the call silently 403s at runtime.
- **Every `new BrowserWindow` must be followed by `hardenRendererWindow(win, role)`** — that is what populates `_rendererRoles`. Skip it and the window's role is `unknown`, so *every* IPC call throws.

**Local media**: privileged schemes `asset://` (allowlisted to `_projectReadableRoots()`) and `hf-preview://project/...` (only `<PROJECT_DIR>/hyperframes`, deliberately a separate origin so the preview iframe can't reach preload). Both honor Range requests; neither bypasses CSP.

**Build**: `run-build` → `src/settings/build-env.js:applyOptionsToEnv()` → `spawn(process.execPath, ['src/pipeline/build-video.js', ...], {shell:false})`. The pipeline emits `@@EVT@@<json>` stdout sentinels → stripped, mirrored to `logs/build-summary-*.log`, forwarded as `build-event`, mapped through `PHASE_PROGRESS` into a monotonic `build-progress`.

**Render**: `hyperframes-render` → `purgePartialHyperframesBrowser()` → `checkHyperframesNodeRuntime()` (**node 22+ required, hard fail**) → optional In/Out clip → `runMotionQa` (hardFail blocks) → `runHyperframesCli()` → 3-tier fallback (browser-GPU/N workers → 1 worker software → CPU encode) → `finishAudio()` → `finalReview()`.

**DevTools remote debugging is OFF by default** — only `YTA_REMOTE_DEBUG=1` opens it, bound to 127.0.0.1 on `YTA_REMOTE_DEBUG_PORT` (default 9223).

## Build Pipeline (`src/pipeline/build-video.js`)

31 numbered steps, sequential, every one wrapped in try/catch with graceful degradation. Resume/checkpoint supported.

| Step | What |
|---|---|
| 0 | Clean old build artifacts |
| 1 | Find audio → `agents/directors-brief.js` (Director's Brief) |
| 1.1 | Source-media probe (ffprobe narration gate) |
| 1.5 | Narration speech-cleanup (writes `.cleaned.mp3`) |
| 2 | Transcribe (`pipeline/transcribe.js` — WhisperX preferred, vanilla Whisper fallback; `WHISPER_ENGINE`/`WHISPER_MODEL`) |
| 3 | **AI Director** (`agents/ai-director.js`) — scene splitting via Smart Splitter (`speech-units` + `scene-boundary-scorer` + `scene-optimizer`), context/format/hook/CTA detection, theme selection |
| 3.4 | **Presenter Director** (talking-head) — agentic; `presenter-assignment.js` is the deterministic floor |
| 3.5 | **Map Assignment** (`map/map-assignment.js`) — deterministic per-scene map disposition |
| 4 | **Visual Planner** (`agents/ai-visual-planner.js`, 6.4k lines) — ONE batch call plans keywords/queries/effects/mgHint for all scenes |
| 4.1 | Per-scene / time-targeted directive applier (`directives/directive-util.js`) |
| 4.8 | **Orchestrator pre-build review** (`pipeline/build-orchestrator.js`) + map compile (`map/map-compiler.js`); writes resume checkpoint |
| 4.85 | Editor Agent template rhythm |
| 4.9 | Topic footage scout |
| 5 | **Download Media** (`media/footage-manager.js`) — blocks first on `visionGpu.ensureReady()`, inline vision scoring |
| 5.05b | **Editor Agent (CEO)** (`agents/ceo.js`) — per-scene framing/effects decisions |
| 5.1 | Aspect ratio & framing (legacy fill-in) — GPU is **stopped** right after this |
| 5.9 | Resolve presenter media (talking-head) |
| 6 | **AI Motion Graphics** + map merge |
| 6.05 / 6.06 / 6.07 | Explainer images / map images (MapTiler) / map waypoint icons |
| 6.5 | **AI Templates** — fullscreen template cards on V3 |
| 6.9 | **HyperFrames Motion Director** — writes `agenticComposition` per item |
| 6.95 / 6.96 | SFX download (Freesound) / music bed |
| 6.96b | **Transition Director** |
| 6.97 | **Sound Designer** (agentic SFX) |
| 7 | Build `public/video-plan.json` |
| 7.6 | **Composition Author** (`render/hf-template-author.js`) — agent-authored MGs |
| 7.7 | **Compliance Loop** — verify + fix against creator directives |
| 7.8 | **Motion QA** — automatic animation preflight |
| 8 | Copy assets to `public/` |

Alternate entries into the same file: resume-from-checkpoint, repeat-from-Step-4, MG-only mode, and a Style-Studio pre-built-plan path.

**Dead steps still in the file** — do not "fix" them, they are intentionally inert:
- **4.7** Compositor Planner — disabled (`agents/ai-compositor-planner.js`; V2 overlay needs rework).
- **5.05** V2 overlay download — `plannedV2Scenes` is a `const []` that is never pushed to.
- **4.95** Niche fallback pool — `downloadFallbackPool()` is defined and never called.

## AI Brain (`src/brain/ai-provider.js`)

Unified `callAI()` / `callVisionAI()` / `callVideoAI()`. Config in `src/settings/config.js`.

- **Text**: **AWS Bedrock** is the base brain, with a per-task model split (`BEDROCK_PLANNER_MODEL`, `BEDROCK_UTILITY_MODEL`, `BEDROCK_FALLBACK_MODEL`). Hybrid routing via `_normalizeTextTaskType` / `_textRouteKey` can put **AiLink** (GPT-5.5), **APlink** (Claude relay), **Azure Claude**, or **Azure OpenAI** (grok) *beside* Bedrock for specific task types, with Bedrock as automatic fallback.
- **`AI_PROVIDER` is a decoy for every value but one.** The hybrid brains sit *beside* Bedrock through their own gates, so real routing is `AILINK_TASK_TYPES` / `APLINK_TASK_TYPES` / `AZURE_TASK_TYPES` / `AZURE_OPENAI_TASK_TYPES`, and `config.aiProvider` resolves to `'bedrock'` regardless. The exception is **`azure-managed`**, which *replaces* Bedrock (one endpoint, two deployments, no Bedrock fallback) and therefore has to be visible to `_getTextRoute` as the primary — `config.aiProvider` reads `AI_PROVIDER` for that one value only. While it was hardcoded, picking "Azure Managed" in the dropdown could never take effect: requests fell through to the hybrid `AZURE_OPENAI_TASK_TYPES` gate and 401'd against the wrong endpoint. Gated by `scripts/verify/vision-backend-routing.js`.
- **`VERTEX_*` is dead** — only `GOOGLE_APPLICATION_CREDENTIALS` survives, and only for the Studio (Gemini) path.
- `cost-tracker.js` prices every call per run, broken down by provider/model/task.
- Removed providers: NVIDIA client, Gemini vision, Ollama/OpenAI/DeepSeek/Groq direct, Google CSE.

**AI Connections — the universal plug (`brain/connections.js` + `brain/connection-transport.js`).** The data-driven replacement for hand-wiring providers. A *connection* = address + key + model name(s) on any **OpenAI-compatible** server (vLLM/SGLang/TGI on Modal, DigitalOcean, AWS, GCP, Oracle, RunPod; Azure AI Foundry; OpenRouter; Meta Model API; Ollama). Three *jobs* — **Thinking** (brain, planner-*, review, motion-graphics, template), **Everyday** (utility, general, classifier), **Eyes** (all vision + `callVideoAI`) — each point at a connection, a backup, or `builtin`.
- Hooks are the two front doors only: `_getTextRoute` (wraps the untouched `_getBuiltInTextRoute`) and `_getVisionChain` (wraps `_getBuiltInVisionChain`); entries are `connection:<id>`. **A job on `builtin` routes byte-for-byte as before**, and `providerOverride` always takes the built-in route. `vision-gpu.ensureReady()` skips the rented box when Eyes is fully on a connection.
- The transport **learns each server's dialect from its own 400s** (`max_tokens`↔`max_completion_tokens`, temperature omitted) instead of guessing from model names; strips a leading `<think>` block; retries 429/5xx/transport; per-connection concurrency; `testConnection()` returns plain-English steps (reach / write / see a red square).
- Storage: `settings/ai-connections-store.js` → `<userData>/ai-connections.json`, keys encrypted with Electron `safeStorage` (injected crypto; honest "not encrypted" fallback). The renderer only ever gets `hasKey`. Main applies it in-process via `connections.setRuntime()`; a build child receives it ONLY as `buildEnv.FORGE_AI_CONNECTIONS` (never `process.env`, so ffmpeg/yt-dlp/render children never see keys).
- UI: AI settings → *AI Connections* (`ui/js/ai-connections-panel.js`, textContent only). IPC: `ai-connections-get/save/test`.
- Gated by `scripts/verify/ai-connections.js` (81 checks, fake OpenAI server, incl. a real child process routing through its env) and `npm run verify:runtime-ai-connections` (boots Electron, fills the form, Save → Test → pick job, checks the key is encrypted on disk; 18 checks).

**`agents/base-director.js`** is the one copy of the 12-step control-flow skeleton the six "triad" brain directors used to hand-roll each. **`agents/registry.js`** is the declarative catalog of those directors:

| id | module | cache file | flag |
|---|---|---|---|
| effects | workers/effects-director | `.hf-fx-cache.json` | `HF_FX_AGENT` |
| transitions | workers/transition-director | `.hf-tx-cache.json` | `HF_TRANSITION_DIRECTOR` |
| icons | workers/icon-director | `.hf-icon-cache.json` | `HF_ICON_DIRECTOR` |
| sound | workers/sound-designer | `.hf-sfx-cache.json` | `HF_SOUND_DESIGNER` |
| presenter | workers/presenter-director | `.hf-presenter-cache.json` | `HF_PRESENTER_DIRECTOR` |
| directives | directives/directive-compiler | `.hf-directives-cache.json` | `DIRECTIVE_COMPILER` |

`taskType` + `cacheFile` + version tags in that registry are **SACRED** — changing them re-bills AI and invalidates caches.

## Vision + Rented-GPU Cost Control (`src/vision/`)

Prompts live in `vision/ai-vision.js`; transport is `brain/ai-provider.js:callVisionAI`.

- **Backends**: `VISION_BACKEND` = `aws` (default) | `lightning` | `bedrock` | `dashscope` | `azure-managed`, resolved by `config.resolveVisionBackend()`. `azure-managed` is the vision half of the Azure Managed brain — same endpoint, no GPU machine, no key pool; the AI Provider dropdown switches this setting with it, because a `VISION_BACKEND` written behind the UI's back loses to the stale value the UI republishes through `YTA_ENV_LOCK`. It snapshots the raw `.env` baseline once (`_RAW_VISION_ENV`) and restores it on every call so the UI dropdown can switch backends live. **Add a new `QWEN_*`/`VISION_*` override to `_RAW_VISION_ENV` or it will stack across switches.**
- **Fallback chain**: `qwen` → `bedrock-qwen-vl` → `bedrock-claude` → `bedrock-nova`. Nova is the *last* emergency fallback, not the first choice. `VISION_EXCLUDE_QWEN=1` drops the GPU (per-scene Retry does this).
- **Cost model**: `vision-gpu.js` is the ONE control surface, dispatching to `vision-box.js` (AWS EC2) or `lightning-box.js` (Lightning Studio via `python src/lightning-control.py`). The GPU starts **just-in-time at Step 5** and is **stopped the moment scoring+framing end (Step 5.1)** — never during transcribe/Director/render. `_weStarted` means a user-pre-warmed box is left running.
- `vision-rewake.js` is a mid-build watchdog, deliberately **disarmed** after the media phase so the light Step 7.6 review can't trigger a multi-minute cold boot.
- `vision-cache.js` keys verdicts by `CACHE_VERSION::kind::normalizedUrl#Ns::scopeHash`.
- `vision-score-sanity.js` exports two functions with **opposite directions**: `applyVisionScoreSanity` raises a floor; `clampSelfReportedDefects` caps at 4.
- Lightning specifics: `lightning-rotation.js` pools accounts from `lightning-accounts.json`. Credit exhaustion is *inferred* (no balance API); monthly reset is MANUAL. The cloudflared tunnel URL is **ephemeral** — `_applyUrl()` must push it into `config.qwen.baseUrl`, because call sites read that cached object, not `process.env`.

## Media Subsystem (`src/media/`)

`footage-manager.js` (~10k lines) is the orchestrator: downloads scenes in parallel with per-scene priority from `sourceHint` (stock/youtube/web-image), inline vision scoring. It is the only consumer of the provider registry.

Layers above it: `media-intent-controller.js` (deterministic lane authority) → `media-agent.js` (AI scene brief) → `media-hunter.js` (what "good footage" means in the lane) → `media-scout.js` (pre-download metadata rejection) → `candidate-finalist-scout.js` → `candidate-race.js` (parallel download+score) → `candidate-referee.js` (final AI editor pass, clean-beats-defective rule). Support: `clip-prescreen.js` (cheap ffmpeg black/frozen detect before paying for vision), `clip-analyzer.js` (multi-frame clip vetting), `retrievability-rescue.js` (rewrites un-findable visual intents into findable B-roll BEFORE download), `media-memory-bank.js`, `title-sanity.js` (deliberately non-blocking), `source-policy.js`, `transcript-scout.js`, `topic-footage-scout.js`.

**Screen-aware racing** (`candidate-race.js`): the Thumbnail Screen (`vision/thumbnail-vision.js`) judges ~25 previews in ONE call and hands its per-candidate verdicts to the race. Candidates it declined wait behind the rest, never share a batch with them, and get a 2-candidate probe; a failed probe ends the race. Still a ranking, never a gate — and it learns in-run per provider (declined candidates must pass at < half the liked rate once ≥6 are raced, or deferral switches off; `FOOTAGE_RACE_SCREEN_DEFER=0` disables). The race also commits a HELD accepted clip when a later batch finds nothing — it used to delete it and return null. Every build prints `[Race Economy]` and writes `race-economy.json`. Vision spend is split by purpose in the cost report via `withCostPurpose()` (`brain/cost-tracker.js`, report-only, never routing). Gated by `scripts/verify/race-economy.js`.

**Providers** (`src/media/providers/`) all extend `base-provider.js`: pexels-image/video, pixabay-image/video, brave-image, bing-image (keyless scraper — Bing's APIs retired 2025-08), reddit-video, youtube-video, storyblocks-video, plus `ytdlp-utils.js`.

`base-provider.js` owns: forced axios `'http'` adapter (the XHR adapter breaks streaming in Electron), a **403 referer ladder** (google → host origin → none), transient retry/backoff, byte-capped safe streaming, HTML/JSON content-type + <5KB rejection, ffmpeg PNG `_sanitizeImage()` (**returns a possibly different path** — use the return value), watermark/min-size rejection (1280×720, images only), `pickUnused()` dedup.

**Generation lane** (not `BaseProvider`): `AI_VIDEO_BACKEND=kling` (default; browser bridge on saved cookies, spends account credits, no key) or `veo` (hosted API, real money per second, inert unless `VEO_AI_VIDEO=1`). Veo is API-only **on purpose** — driving Google's web UI with cookies would risk the account that owns the YouTube channel. `kling-avatar-browser.js` produces talking-head presenter clips.

Removed: nvidia-client, google-cse/google-images, old bing-images (plural), unsplash, vk-video, telegram-video.

## Rendering — HyperFrames Bridge (`src/render/`)

`hyperframes-bridge.js` (5.5k lines) turns `public/video-plan.json` into a self-contained project at `<project>/hyperframes/yta-hf-<iso>-<pid>-<rand>/`: `index.html`, `media/`, `vendor/gsap.min.js`, and JSON diagnostics. The generated HTML registers a single paused master GSAP timeline as `window.__timelines['yta-hyperframes']`. The `hyperframes` npm CLI (**^0.7.64**) captures it frame-by-frame via `chrome-headless-shell`. `main.js` orchestrates via `runHyperframesCli()`. The in-app preview loads the *same* generated HTML in an iframe (`hyperframes-preview-frame`).

- **The preview is NOT byte-identical to the render.** `options.preview=true` keeps the `/*HF_PREVIEW_START*/…/*HF_PREVIEW_END*/` runtime; render builds **strip** it, because its `performance.now()` fails the CLI's determinism scan.
- **Entrance-guard priming**: every sub-timeline is force-rendered `tl.progress(1,true).progress(0,true)` before being added to the master. Authored comps must *also* open with explicit `gsap.set` initial states or frame 0 shows the finished layout.
- **Backdrop coverage rule**: a ±X% pan needs scale ≥ `1 + 2*X/100`. `needsBackdrop` keys off real coverage, not the framing label.
- **Grain is a baked 96×96 LCG PNG**, not `feTurbulence` — an SVG turbulence filter is re-rasterized every frame and leaks GPU memory until capture dies with "Target closed".
- Scene media uses **reserved negative track indices** (`-10000 + base*1000 + n`); voiceover=30, `sfxClips[i]`=31+i. Crossfades start at the outgoing scene's end.
- Housekeeping: prunes old project dirs (`HF_KEEP_PROJECTS`=3) and runs a disk pre-flight that **throws** below `HF_HARD_MIN_FREE_GB`.
- `audio-mixer.js` runs post-render (non-partial only): optional looped music bed ducked via `sidechaincompress`, then `loudnorm=I=-16:LRA=11:TP=-1.5`. Non-destructive; `AUDIO_FINISHING=0` disables.

Other render modules: `hf-template-author.js` (agent authors bespoke MGs; textual + numeric-whitelist + visual lint + repair round + cache `.hf-authored-cache.json`; perfectionist vision review; **OPEN MODE is cache-only and must never call AI**), `hf-visual-lint.js` (rendered-pixel checks — overflow/overlap/invisible/no-entrance/overlay-coverage — + `captureHeroFrame`), `hf-effects.js` (17 animated CSS/GSAP effects + 9 grades), `hf-look-ruleset.js` (the colorist rulebook — one film stock per video, one era family, single grade owner), `hf-background-packs.js` (7 theme-tinted packs, one per video), `hf-design-doc.js`, `hf-adaptive-contrast.js`, `hf-palette-coherence.js`, `hf-character-rig.js`, `graphic-shells.js` (structural chrome, distinct from themes), `mg-registry.js`, `agentic-composition.js`, `overlay-visual-policy.js`, `render-spec.js`, `effect-presets.js`, `text-style-ranges.js`, `hyperframes-motion-director.js`.

## Agents

**Pipeline directors** (`src/agents/`): `ai-director.js` (3.1k), `ai-visual-planner.js` (6.4k), `ai-motion-graphics.js` (2.6k), `ai-templates.js` (1.7k), `ceo.js` (Editor Agent CEO), plus the Smart Splitter trio (`speech-units` → `scene-boundary-scorer` → `scene-optimizer`), `scene-classifier.js` (8-class taxonomy → `data/class-treatment-map.js`), `smart-segment.js`, `scene-risk.js`, `scene-context.js`, `frame-extractor.js`, `planner-display-guards.js`, `presenter-assignment.js`, `design-intelligence.js`, `directors-brief.js`, `scene-actions.js` (timeline right-click Retry / CEO edit — reuses the real media system).

**Brain workers** (`src/agents/workers/`): effects-director, transition-director, icon-director, sound-designer, presenter-director, composition-author, framing + framing-strategy, templates, motion-graphics, transitions, explainer-images, map-assets, keyword-glow, motion-qa-agent (2.6k), sfx-rules.

Pattern for the agentic workers: ONE cached batch brain call, disk-cached, with a **deterministic mechanical floor** as graceful fallback when the flag is off or the call fails (e.g. sound-designer ↔ mechanical SFX floor, presenter-director ↔ `presenter-assignment`, transition-director ↔ `transitions.js`).

**Editor Supervisor** (`src/agents/editor-supervisor/`) — the in-app conversational editor, reached from `ui/js/editor-agent-panel.js` via main.js IPC. `index.js` exposes `planRequest` → `executePlanned` (plans have a 15-min TTL). Capabilities are **auto-discovered from the directory** by `capabilities/registry.js` (files matching `^[a-z0-9][a-z0-9-]*\.js$`, excluding `capability-contract.js`, `registry.js`, `smart-router.js`; duplicate ids throw). Capabilities: audio, captions, effects, framing, graphics, icons, media, pacing, timeline, transitions. Separate `workers/` apply the edits. Support: `visual-observer.js`, `visual-grounding.js`, `plan-diff.js`, `operation-graph.js`, `operation-planner.js`, `session-store.js`, `history-store.js`, `quality-loop.js`, `autonomous-runner.js`, `transaction-assets.js`.

## Directives (agentic control layer)

`src/directives/directive-compiler.js` turns the creator's one free-text "AI Instructions" order into a **single structured directives object every stage reads the same way** — replacing ~4 divergent ad-hoc parsers. Applied per-scene/time at Step 4.1 (`directive-util.js`), verified and deterministically repaired at Step 7.7 (`compliance-loop.js`). `directive-actuator.js` is the post-build acting bridge (QA chat / right-click free text) and deliberately **reuses the build-time machinery** rather than adding a parallel intent parser. Presets: `effect-preset.js`, `framing-preset.js`, `transition-preset.js`, `numeric-signals.js`. User directives beat niche bans.

## Agent Remote Control (`src/remote/`)

Lets an **outside** agent drive the app: Claude Code, Meta Muse, ChatGPT actions, n8n, a curl script. **OFF by default** — AI settings → *Agent access* (`ui/js/agent-access-panel.js`), stored in `<userData>/agent-access.json` (`{enabled, port, token}`), never in `settings/schema.js` because main needs it before any window exists. Env: `FORGE_AGENT_SERVER`, `FORGE_AGENT_PORT`, `FORGE_AGENT_HOST` (loopback or Tailscale CGNAT only; anything else needs `FORGE_AGENT_ALLOW_NETWORK=1`).

- **`tools.js` is the ONE catalog** (12 `forge_*` tools + `SERVER_INSTRUCTIONS`). MCP `tools/list`, the REST routes and `openapi.json` are all generated from it, so transports cannot drift. Adding a tool = one entry + one handler in `control-service.js` (the verify gate asserts the two sets are equal).
- **Transports** (`server.js`, one `node:http` server): `POST /mcp` (Streamable HTTP, stateless JSON — no SSE, no session ids), `GET /api/tools` + `POST /api/tools/<name>`, `GET /files/<name>` (Range, confined to `OUTPUT_PATH` by real path + extension allowlist), `GET /openapi.json` and `/health` (the only keyless routes).
- **Guards**: 127.0.0.1 by default (a Tailscale Funnel / cloudflared tunnel reaches it through loopback, so nothing listens on the LAN); constant-time bearer/`X-Forge-Key` check; **any request carrying an `Origin` header is refused**, which closes the DNS-rebinding hole the MCP spec warns about; 1 MB JSON bodies.
- **THE RULE: an agent presses the same controls a human does.** Anything user-facing is forwarded to `ui/js/remote-control.js`, which writes real DOM controls (+ fires their `change` events) and calls the real `generateVideo()` / `renderVideo()` / `cancelProcess()` / `adoptImportedAudio()`. There is no agent-only build path. Long jobs return a `jobId` immediately; the agent polls `forge_get_status` (which reads `state.lastProgress`, i.e. exactly what the progress bar says).
- Narration import has one implementation (`main.js:_importNarrationFile`) shared by the drop zone and `forge_import_narration`; the URL form goes through `security/safe-download.js`.
- Only the primary instance serves (`_isProjectChildInstance` opts out). `scripts/forge-mcp-stdio.js` bridges stdio-only MCP clients to the HTTP endpoint.
- Gated by `scripts/verify/remote-control.js` (141 checks) **and** `npm run verify:runtime-remote`, which boots Electron and drives the live app over HTTP (38 checks).

## Map System (`src/map/`)

- **Step 3.5** `map-assignment.js` — deterministic `must_map | can_map | must_not_map` per scene. **Hard pre-filter**: only 6 niches are scored at all (news.politics, news.military, explainer.politics/military/history/nature). Presenter HOLD beats and CTA zones force `must_not_map`.
- **Step 4.8** `map-compiler.js` — builds the authoritative `MapScene` (mapMode locator|route|region|comparison, subjects, cameraPlan, annotationPlan) onto `scene._mapScene`. Runs ONCE on the final post-orchestration state.
- **Step 6.06** `map-provider.js` (1.9k) — geocode (MapTiler → Wikipedia → GEO_COORDS), stitch @2x tiles, fetch OSM polygons from Nominatim (**1 req/sec + User-Agent are enforced in code**), write `mapScene.renderAssets` **by reference, no clones**.
- **Render** `map-hf-builder.js` — basemap `<img>` + projected OSM SVG + route + pins, injected into the HF page. `HF_MAP_BUILDER=0` falls back to static markup.

Gotchas: `map-render-engine.js` is **dead code** (zero requires). The JOURNEY camera is **dormant** — nothing writes `mapScene.segments`. Style packs (`BUILD_MAP_STYLE_PACK`, 4 packs) barely reach the HF path — only `pack.extraDetail`; their full styling is consumed by the legacy WebGL compositor. Note "5 styles" = 5 *tile basemaps*, which is orthogonal to the 4 *style packs*.

## Studio (`src/studio/`)

Separate windows, Gemini-backed (the one surviving Vertex/Gemini consumer): `qa-studio-agent.js` (renders real clips via ExportPipeline and sends video to Gemini; 5 fix strategies, fix history, auto-save), `qa-chat-agent.js`, `qa-features-context.js` (auto-captures live capabilities so the QA agent knows what to expect), `qa-replacer.js` (surgical scene replacement through the real footage-manager), `style-learner.js` (one-shot reference-video → style profile JSON), `style-studio-agent.js` (4.4k — persistent conversational session with Files API uploads, session persistence, auto-learning memory).

## UI (`ui/`)

6 windows: `index.html` (main), `startup.html`, `qa-studio.html`, `qa-chat.html`, `style-studio.html`, `footage-resources.html`.

`ui/js/app.js` is a **13,552-line single-file monolith** holding timeline-editor state (3 video tracks), HyperFrames preview, legacy compositor preview, clip properties panel, build settings. P8 will split it; until then, grep — don't read.

`ui/js/settings-io.js` is schema-driven read/write of element-backed settings — it killed the old 5-place field duplication. **Add a setting in `src/settings/schema.js`, not in app.js.**

**Legacy WebGL2 compositor** (`ui/js/compositor/`: Compositor, MGRenderer, ShaderLib, TransitionRenderer, ExportPipeline, SceneGraph, TextureManager, VideoFrameSource, AnimationUtils) is an alternate in-app preview path (`initCompositor`/`loadPlanIntoCompositor`, `state.compositorActive`) and the QA Studio clip exporter. It is **not** the final render engine. `src/ffmpeg-renderer.js` and `src/canvas-mg-renderer.js` were removed, but the WebGL2 *export* IPC family in main.js is still wired and reachable from the QA Studio role.

## Settings & Environment

**`src/settings/schema.js` is the SINGLE SOURCE OF TRUTH** for build/UI settings (25 entries; groups AI/Build/Format/Category/Vision/Presenter/AIVideo/Media/Diagnostics/Project/Editor). It is dual-loadable (`module.exports` in Node, `window.SETTINGS_SCHEMA` in the renderer). Per-setting fields: `key, el, env, build, def, persist, projEnv, group`. `config.js`, main.js's buildEnv, `PROJECT_OVERRIDE_KEYS` and UI persistence all derive from it. **Adding a setting = one entry here.** `src/settings/build-env.js:applyOptionsToEnv()` is the one place UI options become child-process env.

**Env precedence — `YTA_ENV_LOCK`.** `config.js` loads three env layers: repo `.env`, then the user `.env` at `YTA_USER_ENV_PATH` (**`override: true`** — it beats the repo one *and* anything the parent passed in), then the project `.env` filtered to `PROJECT_OVERRIDE_KEYS`. That middle layer used to silently overrule live UI choices (2026-08-04: the Vision Backend dropdown never reached a build). `applyOptionsToEnv()` now collects everything the UI chose into an `own` object and publishes its key list as `YTA_ENV_LOCK`; `config.js` snapshots those keys before the first dotenv load and restores them after the last. **Effective precedence: this build's UI choices > project `.env` > user `.env` > repo `.env`.** A setting with a non-null `env` + `build` is protected automatically — `env: null, build: null` means the control changes the app only, never a build.

**The app reads ~518 distinct environment variables.** This file documents the load-bearing ones only; `schema.js` + `config.js` are authoritative. Nearly every named subsystem has an undocumented default-ON kill switch — grep before assuming a feature can't be disabled.

Load-bearing vars: `BUILD_PRODUCTION_MODE`, `BUILD_FORMAT`, `BUILD_THEME`, `BUILD_QUALITY_TIER`, `BUILD_MAP_STYLE_PACK`, `BUILD_RECIPE`, `BUILD_AUDIENCE`, `BUILD_FAST_MEDIA`, `BUILD_REPEAT_FROM`, `BUILD_RESUME`, `AI_INSTRUCTIONS`, `WHISPER_ENGINE`/`WHISPER_MODEL`, Bedrock creds + the model-split trio, `AILINK_*`/`APLINK_*`/`AZURE_*` task-type routing, `VISION_BACKEND` + `QWEN_BASE_URL` + `QWEN_VISION_API_KEY` + `VISION_EXCLUDE_QWEN` + `VISION_CACHE_VERSION`, `LIGHTNING_*` (~15), `VISION_BOX_INSTANCE_ID`, footage provider keys, `AI_VIDEO_BACKEND` + `KLING_*` + `VEO_*`, `STORYBLOCKS_SUBSCRIBED`.

`EDITOR_AGENT` is the biggest undocumented switch (13 read sites, must be the literal string `'true'`, never set by build-env.js). `HF_TEMPLATE_AUTHOR` is the master switch above the `HF_AUTHOR_*` family. Other HF flags: `HF_AUTHOR_PERFECTIONIST`, `HF_AUTHOR_SUBJECT_FETCH`, `HF_AUTHOR_OVERLAYS`, `HF_AUTHOR_REFRESH`, `HF_TRANSITION_DIRECTOR`, `HF_ICON_DIRECTOR`, `HF_SOUND_DESIGNER`, `HF_FX_AGENT`, `HF_PRESENTER_DIRECTOR`, `HF_BACKGROUND_PACKS`, `HF_FACE_ANCHOR`, `HF_MOTION_DIRECTOR`, `HF_MAP_BUILDER`, `HF_ADAPTIVE_CONTRAST`, `HF_KEEP_PROJECTS`, `HF_MIN_FREE_GB`, `HF_HARD_MIN_FREE_GB`, `HF_MOTION_QA_*`, `AUDIO_FINISHING`, `MUSIC_BED_PATH`, `KARAOKE_CAPTIONS`, `MAX_FULLSCREEN_MAPS_PER_VIDEO`, `USE_CAMERA_PLAN_STOPS`, `USE_SCENE_CLASSES`, `AGENT_VISUAL_QA`, `DIRECTIVE_COMPILER`, `YTA_REMOTE_DEBUG(_PORT)`, `EXPORT_V2`.

`HF_MOTION_QA_NAV_TIMEOUT_MS` (default `60000`) is the one that unblocks heavy projects: the HyperFrames CLI gives its *diagnostic* browser only **10s** at `page.goto` (`resolveDiagnosticNavigationTimeoutMs`), a tenth of the 60s its capture browser gets, and `PRODUCER_PAGE_NAVIGATION_TIMEOUT_MS` is the only input that reaches it. Motion QA now exports that var to every `lint`/`keyframes`/`check`/`snapshot` child, so a 270-scene proof composition no longer hard-fails with `check_runtime_failure: Navigation timeout of 10000 ms exceeded`.

## Verification Harness (`scripts/verify/`)

This is what makes the reorg safe. **Run `npm run verify` before committing.**

**`scripts/verify/sacred-invariants.json` is a tripwire.** It pins 5 files by path *and* by required content anchors:

| File | Anchors |
|---|---|
| `src/brain/ai-provider.js` | callAI, callVisionAI, taskType, _normalizeTextTaskType, _textRouteKey |
| `src/agents/workers/effects-director.js` | BASE LOOK, one era family per video, single grade owner, HF_FX_AGENT |
| `src/agents/ai-director.js` | buildScenesFromAnchors, buildIdeaScenePrompt, parseIdeaScenePlan |
| `src/directives/directive-compiler.js` | compileDirectives, renderDirectivesBlock, SOURCE_FAMILIES |
| `src/settings/config.js` | PROJECT_OVERRIDE_KEYS |

**Moving any of these requires editing that JSON in the same commit.** That is the point — it forces the move to be deliberate.

Other notable checks: `remote-control.js` (agent MCP/REST surface), `require-paths.js` (every require resolves), `electron-security.js` / `ipc-security.js` / `network-security.js`, `package-hygiene.js`, `settings-surface.js` (schema ↔ UI ↔ env agreement), `timeline-contract.js`, `partial-render-range.js`, `stage-handoff.js`, `hyperframes-bridge-smoke.js`, `overlay-transparency.js`, `graphic-shells.js`, `adaptive-contrast.js`, `motion-qa.js`, `editor-agent*.js`, `visual-observer.js`, `lightning-compat.py`.

## Key Data Flow

All steps feed `public/video-plan.json` — the contract between the build pipeline and the HyperFrames renderer, normalized by `src/project/timeline-contract.js` (`normalizePlan` must stay **idempotent**; it is called twice). Key fields: `scenes[]`, `mgScenes[]`/`motionGraphics[]`/`templateScenes[]` (three first-class graphic sources), `transitions[]`, `overlayScenes[]`, `scriptContext`, `sfxClips[]`, `musicBed`/`musicBedGain`, `narrationVolume`, `_hfBackgroundPack`, plus authored-composition and effect-recipe metadata.

## Multi-Track Video System

- 3 tracks: `video-track-1` (base, z:1), `video-track-2` (middle, z:2), `video-track-3` (top, z:3)
- Each scene has a `trackId`; tracks composite together
- `loadActiveScenes()` loads all scenes active at the current playhead across tracks
- Fullscreen MGs on track-3, overlay MGs on track-2

## Critical Patterns

- **`renderTimeline()` uses innerHTML** — reset `_cachedPlayhead/_cachedTimelineScroll/_cachedTimelineTime = null` before innerHTML or the playhead freezes from stale DOM refs
- **Undo/redo must call `loadActiveScenes()`** after restoring scenes or preview desyncs
- **Font names with double quotes break HTML `style=""`** — `.replace(/"/g, "'")`
- **Authored comps must open with `gsap.set` initial states** (entrance guard) — the bridge primes each timeline (`progress(1,true).progress(0,true)`) to avoid frame-0 showing the finished layout
- **All build steps have try/catch** with graceful degradation — missing API keys skip steps, don't crash
- **HyperFrames render REQUIRES `chrome-headless-shell`**, not full Chrome — a full Chrome hangs capture until the 15-minute protocol timeout. `main.js` locates/repairs it (`findHyperframesHeadlessShell`, `purgePartialHyperframesBrowser`); the purge only deletes when no valid install exists, because an interrupted download leaves a folder that breaks HyperFrames *and* blocks re-download.
- **`loadHyperframesBridgeFresh()` busts `require.cache` on every call** — bridge edits apply without an app restart, so the bridge must hold no module-level mutable state you expect to persist
- **`mg-registry.js` and `effect-presets.js` load BOTH as CommonJS and as bare `<script>` tags** — they are IIFE-wrapped with dual `module.exports` + `window` exposure. Adding ESM syntax or a top-level `require` breaks the renderer.
- **`activeProcess` / `activeProcessType` are single global slots** — only one build or render can be tracked/cancelled at a time
- **`INPUT_PATH`/`OUTPUT_PATH`/`TEMP_PATH`/`PUBLIC_PATH`/`PROJECT_NAME` are reassigned by `applyProjectDir()`** — never capture them at module scope in a closure that outlives a project switch

## Known Dead / Legacy

- `src/map/map-render-engine.js` — zero requires
- `src/providers/`, `src/editor-agent/` — empty leftover directories
- Step 4.7 compositor planner, Step 5.05 V2 overlay, Step 4.95 fallback pool — inert (see pipeline table)
- `refresh-vk-token.js`; `test-map-pipeline.js` (uses pre-reorg paths, throws MODULE_NOT_FOUND)
- `buildGeminiArticlePrompt()` in `vision/ai-vision.js` — defined, never called
- `src/studio/style-studio-agent.js` maps intents to pre-reorg paths (`src/mg-registry.js`, `src/effect-presets.js`, `src/ai-motion-graphics.js`, `src/map-*.js`) — stale strings
- `docs/model-routing-structure.md` is orphaned. **`AGENTS.md` is significantly more stale than this file** — it still describes WebGL2 rendering, `src/build-video.js`, and 8 removed AI providers.
- WebGL2 export IPC family in main.js, `EXPORT_V2`/`_gpuExportAddon`, `render-spec.js:webglEncoderPolicy()` — compatibility only
