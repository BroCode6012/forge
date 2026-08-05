---
name: yta-render-monitor
description: Durably monitor the current YTA Empire render, validate its MP4, notify the fixed Discord yta-empire channel, and start an approved Claude Opus source repair after a real failure or stall.
metadata: { "openclaw": { "emoji": "🎬" } }
---

# YTA Render Monitor

When Abdessamad asks you to watch, follow, monitor, babysit, or report a YTA render, use the fixed background monitor. Do not build inline PowerShell polling or temporary scripts.

Start:

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\Users\user\.openclaw\workspace\tools\yta-render-monitor.ps1 start
```

Status:

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\Users\user\.openclaw\workspace\tools\yta-render-monitor.ps1 status
```

Stop only the monitor:

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\Users\user\.openclaw\workspace\tools\yta-render-monitor.ps1 stop
```

The explicit monitoring request approves this watcher, its fixed Discord notifications, and one Claude Opus source-repair review after a real failure or stall. It does not approve rerendering, publishing, uploading, spending, installing dependencies, committing, pushing, deploying, or reading secrets.

