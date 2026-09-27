# TOOLS.md - Forge

## Workspace

- App root: `D:\Youtube\Forge`
- Stack: Electron, Node.js, WebGL2, HyperFrames, FFmpeg, Python helpers
- Main process: `main.js`
- Renderer bridge: `preload.js`
- UI: `ui/`
- Pipeline: `src/pipeline/`
- Project contract: `public/video-plan.json`
- Output and logs: project-local `output/`, `temp/`, and `logs/`

## Common Commands

- `npm start` — launch the Electron app
- `npm run dev` — launch with development tools
- `npm run build` — run the AI video build pipeline
- `npm run verify:ci` — broad static and verification suite
- Prefer a targeted `npm run verify:<area>` before the full suite.

## Safety Notes

- The working tree is already dirty; inspect `git status --short` before edits.
- Do not print `.env`, cookie files, account JSON, or credential values.
- Builds and renders can use paid APIs, network downloads, and GPU resources.
- The app has internal Editor Agent planning/execution, history, undo, redo, QA, and project revision checks. Use those safeguards instead of bypassing them.
- Production launches do not expose remote debugging. Do not enable it unless explicitly needed for an approved local test.

## Durable Render Monitoring

When Abdessamad asks YTA Manager to watch, follow, monitor, babysit, or report a render, use:

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\Users\user\.openclaw\workspace\tools\yta-render-monitor.ps1 start
```

Use the same command with `status` to check it or `stop` to stop only the monitor. Do not improvise inline PowerShell polling or temporary monitoring scripts.

The watcher follows the current YTA project's logs and output, validates a stable MP4 with ffprobe, and posts a terminal result in the fixed `#yta-empire` Discord channel. A real failure or 15-minute stall can trigger one Claude Opus source-repair review under the owner's monitoring approval. It does not rerender, publish, upload, install dependencies, commit, push, deploy, or read secrets.

## Claude Code Status and Durable Jobs

For current Claude activity:

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\Users\user\.openclaw\workspace\skills\claude-code-operator\scripts\claude-code-operator.ps1 status yta
```

For a new Claude task, write a `.md` request under `C:\Users\user\.openclaw\workspace\requests`, then start:

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\Users\user\.openclaw\workspace\skills\claude-code-operator\scripts\claude-code-operator.ps1 start yta <request-file.md>
```

Always return the job ID. Completion or failure is delivered to the owner's private Discord DM. Do not replace this with broad process enumeration or recursive searches under Claude's profile folders.
