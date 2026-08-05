#!/usr/bin/env bash
# vLLM/FlashInfer JIT-compiles a kernel via the `ninja` EXECUTABLE, which the pip `ninja`
# package installs into the venv's bin (NOT on the default PATH) — so the bare `ninja` call
# fails with "FileNotFoundError: 'ninja'". Put the venv bin on PATH so it's found.
export PATH="$HOME/venv/bin:$PATH"
# serve-vision.sh — bring up vLLM (Qwen2.5-VL) + a cloudflared tunnel on the Lightning Studio.
#
# Idempotent: safe to call repeatedly. It only launches what isn't already running, then
# returns fast (the long-running servers are backgrounded with nohup). src/lightning-control.py
# calls this, then polls ~/tunnel.log for the public URL and waits for vLLM to answer.
#
# Place this at ~/serve-vision.sh on the Studio and `chmod +x ~/serve-vision.sh`.
# Adjust VLLM_BIN / MODEL below if your venv path or model differ.
set -u

VLLM_BIN="${VLLM_BIN:-$HOME/venv/bin/vllm}"
CLOUDFLARED_BIN="${CLOUDFLARED_BIN:-$HOME/cloudflared}"
MODEL="${MODEL:-Qwen/Qwen2.5-VL-7B-Instruct-AWQ}"
SERVED_NAME="${SERVED_NAME:-qwen2.5-vl}"
PORT="${PORT:-8000}"
# READING WINDOW. 4096 was far too small and it failed SILENTLY: vLLM answered
# HTTP 400 ("Input length 4127 exceeds model's maximum context length 4096") and
# the frame was simply lost. The app's own scoring prompt is ~2100 tokens before
# a single pixel is attached, and a contact-sheet grid adds ~1400+, so real
# requests measured 4127-4594 tokens — over the old ceiling by 1% to 12%.
# In the 2026-07-31 build that rejected every image the box was asked to score.
MAX_MODEL_LEN="${MAX_MODEL_LEN:-16384}"
MAX_NUM_SEQS="${MAX_NUM_SEQS:-4}"
# Empty = track MAX_MODEL_LEN. They must never disagree: vLLM refuses to start
# when batched-tokens < model-len and chunked prefill is off.
MAX_BATCHED_TOKENS="${MAX_BATCHED_TOKENS:-}"
MM_LIMITS="${MM_LIMITS:-{\"image\":1,\"video\":0}}"
ATTENTION_BACKEND="${ATTENTION_BACKEND:-TRITON_ATTN}"
SERVE_LOG="$HOME/vision-serve.log"
TUNNEL_LOG="$HOME/tunnel.log"

# A newly attached GPU can appear in nvidia-smi before CUDA is ready inside
# Python. Starting vLLM during that short window makes it exit with
# "Failed to infer device type". Wait for the exact venv/torch runtime that
# vLLM uses, so T4/L4 cold starts are reliable instead of race-dependent.
GPU_READY=0
for attempt in $(seq 1 60); do
  if "$HOME/venv/bin/python" -c \
    'import torch, sys; sys.exit(0 if torch.cuda.is_available() and torch.cuda.device_count() > 0 else 1)' \
    >/dev/null 2>&1; then
    GPU_READY=1
    break
  fi
  if [ "$attempt" -eq 1 ]; then
    echo "[serve] waiting for CUDA driver…"
  fi
  sleep 2
done
if [ "$GPU_READY" -ne 1 ]; then
  echo "[serve] CUDA did not become ready within 120s" >&2
  exit 1
fi

# 1) vLLM on :PORT — launch only if no vLLM PROCESS is already running. We check the process
# (not the port) because while the model is still loading the port doesn't answer yet, and a
# port-based check would wrongly launch a SECOND vLLM that fights the first for GPU memory.

# A reading window that is too SMALL fails silently (HTTP 400 per request, the
# box looks healthy, every frame is lost). One that is too LARGE fails loudly
# (vLLM exits during startup on a CUDA out-of-memory, and the whole build has no
# vision at all). Rather than betting the build on one number, try the widest
# first and step down. Each rung is a complete, serviceable config.
CONTEXT_LADDER="${CONTEXT_LADDER:-$MAX_MODEL_LEN 8192 4096}"
# A rung is PROVEN the moment it answers /v1/models — that is a fact, not a
# guess. Once proven, an exit is a crash of a working config, not the GPU
# refusing the size, and stepping down would quietly shrink the window under a
# running build: the original bug wearing a different hat.
#
# This used to be a wall-clock guess (600s) and it was measurably wrong: on
# 2026-07-31 a 16384 server that had been answering real traffic for 502s was
# killed, and because 502 < 600 the ladder called it a failed startup and shrank
# to 8192. Elapsed time never knew the difference; "did it ever serve?" does.
# BOOT_GRACE is kept only as a backstop for the case where the readiness probe
# itself cannot run (no curl on the box).
BOOT_GRACE="${BOOT_GRACE:-600}"
PROVEN_FLAG="${PROVEN_FLAG:-$HOME/.vision-window-proven}"
# The smallest window that can actually serve this app. Real scoring requests
# measured 4127-4594 tokens, so anything at or below 4096 rejects every image.
# 8192 is the first rung with genuine headroom.
WINDOW_FLOOR="${WINDOW_FLOOR:-8192}"
# Rungs this GPU has already refused to start at, one "<gpu-tag> <window>" per
# line. Keyed by GPU because a T4 and an L4 hold different sizes, and a studio
# can come back on either.
REJECT_FILE="${REJECT_FILE:-$HOME/.vision-window-rejected}"

gpu_tag() {
  nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null \
    | head -n1 | tr -c 'A-Za-z0-9' '-' | sed 's/-\{1,\}/-/g;s/^-//;s/-$//'
}

note_rejected() {
  printf '%s %s\n' "$(gpu_tag)" "$1" >> "$REJECT_FILE" 2>/dev/null || true
}

# True when this GPU has already failed to start at $1 tokens or wider — i.e.
# a small window here is the card's limit, not a stale server, so restarting
# would just churn. Advisory only: VISION_WINDOW_FORCE=1 ignores it.
window_refused_here() {
  [ -s "$REJECT_FILE" ] || return 1
  awk -v tag="$(gpu_tag)" -v floor="$1" \
    '$1==tag && $2+0>=floor {found=1} END{exit found?0:1}' "$REJECT_FILE" 2>/dev/null
}

# Run vLLM at one window, and watch alongside it for the moment it starts
# answering. Returns vLLM's exit code; leaves $PROVEN_FLAG behind if the server
# ever served.
run_rung() {
  local len="$1"
  local batched="${MAX_BATCHED_TOKENS:-$len}"
  local pid watcher code
  # --enforce-eager skips vLLM's torch.compile/CUDA-graph step, which needs the `ninja` build
  # tool (not in the isolated venv → "FileNotFoundError: 'ninja'" crash). Eager mode needs no
  # ninja AND starts faster; inference is plenty fast for image scoring.
  "$VLLM_BIN" serve "$MODEL" \
    --served-model-name "$SERVED_NAME" \
    --host 0.0.0.0 --port "$PORT" \
    --max-model-len "$len" \
    --max-num-seqs "$MAX_NUM_SEQS" \
    --max-num-batched-tokens "$batched" \
    --limit-mm-per-prompt "$MM_LIMITS" \
    --attention-backend "$ATTENTION_BACKEND" \
    --gpu-memory-utilization 0.9 \
    --disable-log-stats \
    --enforce-eager &
  pid=$!
  (
    while kill -0 "$pid" 2>/dev/null; do
      if curl -s --max-time 3 "http://127.0.0.1:${PORT}/v1/models" 2>/dev/null | grep -q max_model_len; then
        : > "$PROVEN_FLAG"
        break
      fi
      sleep 5
    done
  ) &
  watcher=$!
  wait "$pid"
  code=$?
  kill "$watcher" 2>/dev/null || true
  return "$code"
}

start_vllm() {
  trap '' HUP   # outlive this script exiting (the nohup equivalent for a function)
  local prev=""
  for len in $CONTEXT_LADDER; do
    # The ladder starts at MAX_MODEL_LEN, so an override of 8192 or 4096 would
    # otherwise retry itself. Skip any rung that repeats or grows.
    if [ -n "$prev" ] && [ "$len" -ge "$prev" ]; then continue; fi
    prev="$len"
    echo "[serve] vLLM attempt — reading window $len tokens (batched ${MAX_BATCHED_TOKENS:-$len})"
    local t0
    t0=$(date +%s)
    rm -f "$PROVEN_FLAG"
    run_rung "$len"
    local code=$?
    local elapsed=$(( $(date +%s) - t0 ))
    echo "[serve] vLLM exited (code $code) after ${elapsed}s at window $len"
    if [ -f "$PROVEN_FLAG" ]; then
      echo "[serve] window $len had already served requests — that was a crash, not a refusal. Not shrinking it."
      return "$code"
    fi
    if [ "$elapsed" -ge "$BOOT_GRACE" ]; then
      echo "[serve] window $len ran ${elapsed}s without the probe confirming it — treating it as proven anyway. Not shrinking it."
      return "$code"
    fi
    echo "[serve] window $len did not survive startup — trying the next one down"
    note_rejected "$len"
  done
  echo "[serve] every reading window failed to start; see $SERVE_LOG" >&2
  return 1
}

# ── what window is a RUNNING vLLM actually serving? ──────────────────────────
# Two readers. /v1/models is authoritative — it is the number the server
# enforces — but it stays silent while the model is still loading; the process
# cmdline answers even then.
running_window() {
  local body n pid
  body=$(curl -s --max-time 5 "http://127.0.0.1:${PORT}/v1/models" 2>/dev/null || true)
  n=$(printf '%s' "$body" | tr ',{}' '\n\n\n' \
      | sed -n 's/.*"max_model_len"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' | head -n1)
  if [ -n "$n" ]; then printf '%s' "$n"; return 0; fi

  pid=$(pgrep -f "vllm serve" 2>/dev/null | head -n1)   # lowest pid = the parent
  if [ -n "$pid" ] && [ -r "/proc/$pid/cmdline" ]; then
    n=$(tr '\0' ' ' < "/proc/$pid/cmdline" \
        | sed -n 's/.*--max-model-len[ =]\{1,\}\([0-9][0-9]*\).*/\1/p' | head -n1)
    if [ -n "$n" ]; then printf '%s' "$n"; return 0; fi
  fi
  return 1
}

# The ladder from a PREVIOUS launch keeps running in the background after this
# script returns (that is the whole point of it). If it is still alive when we
# kill vLLM, it sees the exit, calls it a failed startup and races us to launch
# its own next rung — two vLLMs then fight over one card and both die. Measured
# exactly that on 2026-07-31: a manual restart produced
# "exited (code 137) at window 8192" then "code 1 at window 4096", GPU at 0 MiB.
# So: retire the old supervisor BEFORE touching its server.
kill_stale_ladders() {
  local pid
  for pid in $(pgrep -f "serve-vision" 2>/dev/null); do
    [ "$pid" = "$$" ] && continue
    [ "$pid" = "$PPID" ] && continue
    kill "$pid" 2>/dev/null || true
  done
  sleep 1
}

stop_vllm() {
  local i used
  kill_stale_ladders
  pkill -f "vllm serve" 2>/dev/null || true
  for i in $(seq 1 40); do
    pgrep -f "vllm serve" >/dev/null 2>&1 || break
    sleep 1
  done
  if pgrep -f "vllm serve" >/dev/null 2>&1; then
    echo "[serve] vLLM ignored TERM — forcing"
    pkill -9 -f "vllm serve" 2>/dev/null || true
    sleep 3
  fi
  # A fresh vLLM claims 90% of the card at startup. If the old one's memory has
  # not been handed back yet, the new one dies on an OOM that has nothing to do
  # with the window size — and the ladder would then blame the window and shrink
  # it, re-creating the exact bug this restart exists to fix. Wait for idle.
  for i in $(seq 1 30); do
    used=$(nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits 2>/dev/null | head -n1)
    [ -z "$used" ] && break
    [ "$used" -lt 1500 ] && break
    sleep 2
  done
}

# 1) Launch vLLM — or replace one that is serving a window too small to use.
#
# This guard used to be a bare "is a vLLM running?" check, which made the whole
# widened-window fix a no-op on any studio that was already warm: it saw a
# server, said "already running", and left a 4096-token vLLM rejecting every
# image for the rest of the session. Presence is not health. Ask the running
# server how wide it reads, and replace it if it cannot do the job.
if ! pgrep -f "vllm serve" >/dev/null 2>&1; then
  echo "[serve] starting vLLM…"
  kill_stale_ladders   # never leave two supervisors climbing the same ladder
  start_vllm >>"$SERVE_LOG" 2>&1 &
  disown 2>/dev/null || true
else
  CUR_WINDOW="$(running_window || true)"
  if [ -z "$CUR_WINDOW" ]; then
    echo "[serve] vLLM already running (reading window unreadable — leaving it alone)"
  elif [ "$CUR_WINDOW" -ge "$WINDOW_FLOOR" ]; then
    echo "[serve] vLLM already running with a ${CUR_WINDOW}-token reading window — usable"
  elif window_refused_here "$WINDOW_FLOOR" && [ "${VISION_WINDOW_FORCE:-0}" != "1" ]; then
    echo "[serve] vLLM running at ${CUR_WINDOW} tokens, under the ${WINDOW_FLOOR} floor — but this GPU has already refused a window that wide, so restarting would only churn. Keeping it."
  else
    echo "[serve] vLLM running at ${CUR_WINDOW} tokens, under the ${WINDOW_FLOOR}-token floor — replacing it"
    stop_vllm
    start_vllm >>"$SERVE_LOG" 2>&1 &
    disown 2>/dev/null || true
  fi
fi

# 2) cloudflared tunnel -> :PORT.
#    Named tunnel (stable hostname vision.<domain>, NO 200-request limit) if a token file
#    exists; otherwise a quick tunnel (random trycloudflare URL) as a fallback.
TOKEN_FILE="$HOME/.cf-tunnel-token"
if [ -s "$TOKEN_FILE" ]; then
  pkill -f "cloudflared tunnel --url" 2>/dev/null || true   # drop any stale quick tunnel
  if ! pgrep -f "cloudflared tunnel run" >/dev/null 2>&1; then
    echo "[serve] starting NAMED cloudflared tunnel…"
    nohup "$CLOUDFLARED_BIN" tunnel run --token "$(cat "$TOKEN_FILE")" >>"$TUNNEL_LOG" 2>&1 &
  else
    echo "[serve] named tunnel already up"
  fi
else
  if ! pgrep -f "cloudflared tunnel --url" >/dev/null 2>&1; then
    echo "[serve] starting QUICK cloudflared tunnel…"
    : > "$TUNNEL_LOG"
    nohup "$CLOUDFLARED_BIN" tunnel --url "http://localhost:${PORT}" >>"$TUNNEL_LOG" 2>&1 &
  else
    echo "[serve] quick tunnel already up"
  fi
fi

echo "[serve] launched"
