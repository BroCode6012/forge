#!/usr/bin/env python3
"""
check-lightning-studio.py — health-check ONE account's Studio end to end:
  start on its configured GPU (T4 by default) → ensure vLLM serving →
  run a tiny REAL vision test → stop the Studio → report.

Run: python tools/check-lightning-studio.py <account-id>   (id from lightning-accounts.json)
Progress → stderr; a single JSON verdict → stdout (last line).
Only stops the Studio if THIS check started it (won't kill one a build is using).
"""
import os
import sys
import json
import time
import base64

# Force UTF-8 stdio (Windows cp1252 crashes on Unicode like '→' from tool output).
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_ROOT = os.path.join(REPO_ROOT, "src")
if SRC_ROOT not in sys.path:
    sys.path.insert(0, SRC_ROOT)

from lightning_sdk import Studio, Machine
from lightning_compat import (
    friendly_start_error,
    is_running,
    start_studio_compat,
    status_name,
)

# 64x64 solid RED png — big enough that the vision model reliably reads the color (a 1x1
# pixel washes out and gives random answers).
RED_PNG = "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAT0lEQVR42u3PQQkAAAgEsAtx/ZMZxgi+hcEKLNO+FgEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQGBywKqxUDxqh7TUQAAAABJRU5ErkJggg=="


def log(m):
    sys.stderr.write(str(m) + "\n")
    sys.stderr.flush()


def emit(o):
    sys.stdout.write(json.dumps(o) + "\n")
    sys.stdout.flush()


def resolve_machine(name):
    value = str(name or "T4").strip().upper().replace("-", "_")
    machine = getattr(Machine, value, None)
    if machine is None:
        try:
            machine = Machine.from_str(str(name))
        except Exception:
            machine = None
    if machine is None:
        raise ValueError("Unknown Lightning machine '{}'. Use an SDK name such as T4 or L4.".format(name))
    return machine


def main():
    if len(sys.argv) < 2:
        sys.exit("usage: check-lightning-studio.py <account-id>")
    acct_id = sys.argv[1]
    pool = json.load(open(os.path.join(REPO_ROOT, "lightning-accounts.json"), "r", encoding="utf-8"))
    a = next((x for x in pool if x.get("id") == acct_id), None)
    if not a:
        emit({"ok": False, "error": "account id not found: " + acct_id})
        return

    os.environ["LIGHTNING_USER_ID"] = a["userId"]
    os.environ["LIGHTNING_API_KEY"] = a["apiKey"]
    kw = {"create_ok": False}
    if a.get("teamspace"):
        kw["teamspace"] = a["teamspace"]
    if a.get("user"):
        kw["user"] = a["user"]
    s = Studio(a["studioName"], **kw)
    machine_name = str(a.get("machine") or os.environ.get("LIGHTNING_MACHINE") or "T4").strip()
    target_machine = resolve_machine(machine_name)

    result = {"ok": False, "account": acct_id, "label": a.get("label", acct_id), "steps": {}}
    result["steps"]["requestedMachine"] = machine_name
    initial_status = status_name(s)
    initially_active = initial_status.lower() in ("pending", "running", "stopping")
    result["steps"]["initialStatus"] = initial_status
    we_started = False
    try:
        if not is_running(s):
            log("Starting Studio on {}…".format(machine_name))
            start_info = start_studio_compat(
                s,
                target_machine,
                timeout=float(os.environ.get("LIGHTNING_START_TIMEOUT", "600")),
                log=log,
            )
            we_started = bool(start_info.get("started"))
            result["steps"]["startMethod"] = start_info.get("method", "unknown")
        else:
            result["steps"]["startMethod"] = "existing"
        if machine_name.lower() not in str(getattr(s, "machine", "")).lower():
            log("Switching to {}…".format(machine_name))
            s.switch_machine(target_machine)
        result["steps"]["machine"] = "running (" + str(s.machine) + ")"

        log("Ensuring vLLM + tunnel…")
        try:
            serve_local = open(
                os.path.join(REPO_ROOT, "lightning", "serve-vision.sh"),
                "rb",
            ).read()
            serve_b64 = base64.b64encode(serve_local).decode()
            s.run(
                "echo {} | base64 -d > $HOME/serve-vision.sh && "
                "chmod +x $HOME/serve-vision.sh".format(serve_b64)
            )
            result["steps"]["serveScript"] = "synced"
        except Exception as e:
            result["steps"]["serveScript"] = "sync warning: " + str(e)
        s.run("bash $HOME/serve-vision.sh >/tmp/serve-check.log 2>&1 || true")

        ready = False
        model_attempts = max(1, int(os.environ.get("LIGHTNING_CHECK_MODEL_ATTEMPTS", "80")))
        for i in range(model_attempts):  # default: up to ~20 min for a cold T4
            code = (s.run("curl -s -o /dev/null -w '%{http_code}' http://localhost:8000/v1/models 2>/dev/null || echo 000") or "").strip()[-3:]
            if code == "200":
                ready = True
                break
            log("model loading… %ds" % (i * 15))
            time.sleep(15)
        result["steps"]["serving"] = "yes" if ready else "no"
        if not ready:
            result["error"] = "vLLM never came up (check serve-vision.sh / provisioning)"
            raise StopIteration

        log("Running vision test (expect 'red')…")
        body = json.dumps({
            "model": "qwen2.5-vl", "max_tokens": 20,
            "messages": [{"role": "user", "content": [
                {"type": "text", "text": "What color is this image? Answer in one word."},
                {"type": "image_url", "image_url": {"url": "data:image/png;base64," + RED_PNG}},
            ]}],
        })
        b64body = base64.b64encode(body.encode()).decode()
        out = s.run("echo %s | base64 -d > /tmp/vt.json && curl -s http://localhost:8000/v1/chat/completions -H 'Content-Type: application/json' -d @/tmp/vt.json || echo {}" % b64body)
        try:
            reply = json.loads(out)["choices"][0]["message"]["content"].strip()
        except Exception:
            reply = (out or "")[:120].strip()
        result["steps"]["visionReply"] = reply
        # PASS = the endpoint booted, served, and returned a coherent reply (the whole pipeline
        # works). We also flag whether it correctly read the colour as red.
        result["steps"]["colorCorrect"] = ("red" in reply.lower())
        result["ok"] = bool(reply) and not reply.lower().startswith(("error", "{", "internal"))
        log("Vision replied: " + reply + ("  (correct ✓)" if "red" in reply.lower() else "  (expected red)"))
    except StopIteration:
        pass
    except Exception as e:
        result["error"] = friendly_start_error(e)
        if hasattr(e, "retryable"):
            result["retryable"] = bool(e.retryable)
    finally:
        try:
            if we_started:
                log("Stopping Studio…")
                s.stop()
                result["steps"]["stopped"] = "yes (billing stopped)"
            elif initially_active:
                result["steps"]["stopped"] = "left untouched (initial state: {})".format(initial_status.lower())
            else:
                current = status_name(s)
                if current.lower() in ("pending", "running", "failed"):
                    log("Cleaning up a partial check start…")
                    s.stop()
                    result["steps"]["stopped"] = "yes (partial start cleaned up)"
                else:
                    result["steps"]["stopped"] = "not started (Studio remains {})".format(current.lower())
        except Exception as e:
            result["steps"]["stopped"] = "stop failed: " + str(e)

    emit(result)


if __name__ == "__main__":
    main()
