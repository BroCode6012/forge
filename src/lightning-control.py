#!/usr/bin/env python3
"""
lightning-control.py — start/stop/status the Lightning.ai vision Studio, and bring up
the vLLM server + cloudflared tunnel on it, returning the public tunnel URL.

Invoked by src/lightning-box.js (Node spawns: `python lightning-control.py <cmd>`).
Always prints exactly one JSON line on stdout as the LAST line; progress goes to stderr.

Auth (env):  LIGHTNING_USER_ID, LIGHTNING_API_KEY
Studio (env): LIGHTNING_STUDIO_NAME, LIGHTNING_TEAMSPACE, and one of LIGHTNING_USER / LIGHTNING_ORG
Tuning (env): LIGHTNING_START_TIMEOUT (sec, default 300), LIGHTNING_SERVE_SCRIPT (default ~/serve-vision.sh)

This is intentionally dependency-light: only `lightning_sdk` (pip install lightning-sdk).
All control of the GPU machine itself happens through the SDK's Studio.run(); the heavy
lifting (launch vLLM + tunnel) lives in the studio-side serve script so this stays portable.
"""
import os
import re
import sys
import json
import time
import base64
import socket

from lightning_compat import (
    friendly_start_error,
    start_studio_compat,
)

# Force UTF-8 stdio (Windows cp1252 crashes on Unicode like '→' from tool output).
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def emit(obj):
    """Print the single machine-readable JSON result line on stdout."""
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def log(msg):
    """Human progress → stderr (Node forwards these as toast text)."""
    sys.stderr.write(str(msg) + "\n")
    sys.stderr.flush()


def get_studio():
    from lightning_sdk import Studio
    name = os.environ.get("LIGHTNING_STUDIO_NAME")
    if not name:
        raise RuntimeError("LIGHTNING_STUDIO_NAME not set")
    kwargs = {"create_ok": False}
    teamspace = os.environ.get("LIGHTNING_TEAMSPACE")
    if teamspace:
        kwargs["teamspace"] = teamspace
    org = os.environ.get("LIGHTNING_ORG")
    user = os.environ.get("LIGHTNING_USER")
    if org:
        kwargs["org"] = org
    elif user:
        kwargs["user"] = user
    return Studio(name, **kwargs)


def is_running(studio):
    try:
        from lightning_sdk import Status
        return studio.status == Status.Running
    except Exception:
        return str(getattr(studio, "status", "")).lower().endswith("running")


def ensure_gpu_machine(studio):
    """Make sure the Studio is on the GPU machine (programmatic start can land on CPU, which
    makes vLLM crash with 'Failed to infer device type'). Switches to LIGHTNING_MACHINE (T4)
    if the current machine isn't it. The persistent drive (incl. the model cache) survives the
    switch, so no re-download."""
    desired = os.environ.get("LIGHTNING_MACHINE", "T4")
    try:
        from lightning_sdk import Machine
        target = getattr(Machine, desired, None)
        if target is None:
            raise RuntimeError("Unknown LIGHTNING_MACHINE '{}'; expected an SDK machine such as T4 or L4".format(desired))
        current = str(getattr(studio, "machine", ""))
        if desired.lower() in current.lower():
            log("On GPU machine {} ✓".format(current))
            return False
        log("On {} — switching to GPU machine {}…".format(current or "?", desired))
        studio.switch_machine(target)
        switched = str(getattr(studio, "machine", ""))
        if desired.lower() not in switched.lower():
            raise RuntimeError(
                "Lightning reported a machine switch, but the Studio is still on '{}' instead of '{}'.".format(
                    switched or "unknown", desired
                )
            )
        log("Now on {}".format(switched))
        return True
    except Exception as e:
        message = friendly_start_error(e)
        log("machine switch failed: {}".format(message))
        raise RuntimeError(message) from e


# Lightning's own port hostnames. These belong to exactly one Studio, so one must never be
# reused for another account in the rotation pool.
LITNG_HOST_RE = re.compile(r"\.cloudspaces\.litng\.ai\b", re.I)


def same_endpoint(a, b):
    """Compare two endpoints ignoring a trailing /v1 and trailing slashes."""
    def norm(u):
        u = (u or "").strip().rstrip("/")
        return u[:-3].rstrip("/") if u.lower().endswith("/v1") else u
    return norm(a) == norm(b)


def host_resolves(url):
    """Does this URL's hostname resolve to anything at all?

    A hostname that does not resolve is DEAD — not slow, not booting. Checking it costs
    milliseconds and is the difference between switching to a backup address immediately
    and burning a paid GPU for 15 minutes waiting on a name that will never answer.
    """
    try:
        host = url.split("//", 1)[-1].split("/", 1)[0].split(":", 1)[0].strip()
        if not host:
            return False
        socket.getaddrinfo(host, None)
        return True
    except Exception:
        return False


def native_port_url(studio, port=8000):
    """Lightning's OWN public address for a port on this Studio.

    Needs no domain, no DNS record, no Cloudflare and no third party: the URL embeds the
    studio id, so it is stable for the life of the studio. Returns "" when the installed
    SDK is too old to expose ports (the caller then falls back to a tunnel).
    """
    want = str(port)
    try:
        for e in (studio.list_ports() or []):
            ports = [str(p) for p in (getattr(e, "ports", None) or [])]
            urls = [u for u in (getattr(e, "urls", None) or []) if u]
            if want in ports and urls:
                return urls[0].rstrip("/")
    except Exception:
        pass  # older SDK, or no ports yet — fall through and try to create one
    try:
        for e in (studio.add_ports({"vision": port}) or []):
            urls = [u for u in (getattr(e, "urls", None) or []) if u]
            if urls:
                return urls[0].rstrip("/")
    except Exception as e:
        log("Lightning native port unavailable: {}".format(e))
    return ""


def cmd_status():
    s = get_studio()
    emit({"ok": True, "state": str(s.status)})


def cmd_stop():
    s = get_studio()
    s.stop()
    emit({"ok": True, "state": "stopped"})


def cmd_start():
    serve_script = os.environ.get("LIGHTNING_SERVE_SCRIPT", "~/serve-vision.sh")
    # Only the URL discovery happens here (quick). We deliberately do NOT loop waiting for the
    # model to load via s.run — each s.run is a slow remote round-trip. The Node side polls the
    # public tunnel URL DIRECTLY (fast HTTP), which is far more efficient for the long model load.
    url_timeout = float(os.environ.get("LIGHTNING_URL_TIMEOUT", "150"))
    s = get_studio()
    start_info = {
        "started": False,
        "already_running": is_running(s),
        "method": "existing",
    }

    if not start_info["already_running"]:
        # Start DIRECTLY on the configured GPU (start() can otherwise land on CPU-4, which makes
        # vLLM crash and forces a slow CPU→GPU switch). Passing machine= avoids that switch.
        desired = os.environ.get("LIGHTNING_MACHINE", "T4")
        interruptible = os.environ.get("LIGHTNING_INTERRUPTIBLE", "").lower() in ("1", "true", "yes")
        log("Studio stopped — starting on {}{}…".format(desired, " (interruptible)" if interruptible else ""))
        from lightning_sdk import Machine
        target = getattr(Machine, desired, None)
        if target is None:
            raise RuntimeError("Unknown LIGHTNING_MACHINE '{}'; expected an SDK machine such as T4 or L4".format(desired))
        start_info = start_studio_compat(
            s,
            target,
            timeout=float(os.environ.get("LIGHTNING_START_TIMEOUT", "300")),
            interruptible=interruptible,
            max_runtime=(
                int(os.environ["LIGHTNING_MAX_RUNTIME"])
                if os.environ.get("LIGHTNING_MAX_RUNTIME")
                else None
            ),
            log=log,
        )
        log("Machine started via {}.".format(start_info.get("method", "Lightning")))
    else:
        log("Studio already running.")

    # Safety net: if it somehow isn't on the GPU machine, switch (usually a no-op now).
    switched_by_app = ensure_gpu_machine(s)
    if switched_by_app:
        # Even when the Studio was already running on CPU, the app now owns the
        # paid GPU upgrade and must stop it after the build to prevent a billing leak.
        start_info["started"] = True
        start_info["method"] = "machine-switch"

    # Self-update the studio every start: push the latest serve script + (if configured) the
    # Cloudflare NAMED-tunnel token, so existing studios switch to the named tunnel automatically
    # without manual re-provisioning.
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    try:
        serve_local = open(os.path.join(here, "lightning", "serve-vision.sh"), "rb").read()
        b64 = base64.b64encode(serve_local).decode()
        s.run("echo {} | base64 -d > $HOME/serve-vision.sh && chmod +x $HOME/serve-vision.sh".format(b64))
    except Exception as e:
        log("serve-script push warning: {}".format(e))
    token = os.environ.get("CF_TUNNEL_TOKEN", "").strip()
    if token:
        try:
            s.run("printf %s '{}' > $HOME/.cf-tunnel-token".format(token))
        except Exception as e:
            log("token push warning: {}".format(e))
    else:
        try:
            s.run("rm -f $HOME/.cf-tunnel-token")  # no token → quick-tunnel fallback
        except Exception:
            pass

    # Idempotently launch vLLM + tunnel (the serve script backgrounds them and returns fast).
    log("Launching vLLM + tunnel on the studio…")
    try:
        s.run("bash {} >/tmp/serve-launch.log 2>&1".format(serve_script))
    except Exception as e:
        log("serve launch warning: {}".format(e))

    # Lightning's own public address for port 8000. Free, needs no domain and no DNS record,
    # and stays valid for the life of the studio — so it is always worth having in hand as the
    # automatic backup, whatever the configured tunnel is doing.
    native = native_port_url(s)
    if native:
        log("Lightning direct address: {}".format(native))

    # NAMED tunnel → the public URL is FIXED (vision.<domain>), no log scraping needed.
    if token:
        fixed = os.environ.get("LIGHTNING_VISION_URL", "").strip()
        # A Lightning direct address belongs to ONE studio. The app persists whichever address
        # last worked, so a direct address left over from another account in the pool would
        # resolve perfectly and point at the wrong machine — answering 404 forever. Only ever
        # trust a direct address that this studio just told us is its own.
        if fixed and LITNG_HOST_RE.search(fixed) and same_endpoint(fixed, native) is False:
            log("Ignoring a direct address that belongs to a different Studio.")
            fixed = ""
        # CONFIGURED IS NOT WORKING. A named tunnel only has a public hostname while the DNS
        # record for it exists; move the domain off Cloudflare (or delete the record) and the
        # tunnel stays connected and healthy while the address resolves to nothing. Detect that
        # here — it costs milliseconds — instead of paying for a GPU nobody can reach.
        if fixed and not host_resolves(fixed):
            log("Configured address {} does not resolve — its DNS record is gone.".format(fixed))
            fixed = ""
        if not fixed and native:
            fixed = native
            log("Falling back to Lightning's direct address (no domain needed).")
        if fixed:
            log("Endpoint: {}".format(fixed))
            emit({
                "ok": True,
                "url": fixed,
                "altUrls": [u for u in [native] if u and u != fixed],
                "ready": False,
                "startedByApp": bool(start_info.get("started")),
                "startMethod": start_info.get("method"),
            })
            return
        # Last resort: neither the configured hostname nor Lightning's direct address works.
        # The serve script started a NAMED tunnel (the token file is on the studio), so no
        # trycloudflare URL can ever appear — drop the token and relaunch so it comes up in
        # no-domain mode, then scrape as usual. The token is re-pushed on the next start, so
        # this self-heals the moment the domain works again.
        log("No usable address — restarting the tunnel in no-domain mode.")
        try:
            s.run("rm -f $HOME/.cf-tunnel-token; pkill -f 'cloudflared tunnel run' 2>/dev/null; true")
            s.run("bash {} >/tmp/serve-launch.log 2>&1".format(serve_script))
        except Exception as e:
            log("no-domain relaunch warning: {}".format(e))

    # QUICK tunnel → scrape the random trycloudflare URL from the log (comes up in seconds).
    url = ""
    deadline = time.time() + url_timeout
    url_re = re.compile(r"https://[a-z0-9.-]+trycloudflare\.com")
    while time.time() < deadline and not url:
        try:
            out = s.run("grep -oE 'https://[a-z0-9.-]+trycloudflare\\.com' ~/tunnel.log 2>/dev/null | head -1")
            m = url_re.search(out or "")
            if m:
                url = m.group(0)
                log("Tunnel URL: {}".format(url))
        except Exception:
            pass
        if not url:
            log("Waiting for tunnel…")
            time.sleep(5)

    if url:
        # Hand the URL back immediately; Node waits for the model to finish loading by polling
        # this public URL directly (the model can take several minutes on a cold start).
        emit({
            "ok": True,
            "url": url,
            "altUrls": [u for u in [native] if u and u != url],
            "ready": False,
            "startedByApp": bool(start_info.get("started")),
            "startMethod": start_info.get("method"),
        })
    elif native:
        # No tunnel came up, but Lightning's own address works without one.
        log("No tunnel appeared — using Lightning's direct address instead.")
        emit({
            "ok": True,
            "url": native,
            "ready": False,
            "startedByApp": bool(start_info.get("started")),
            "startMethod": start_info.get("method"),
        })
    else:
        if start_info.get("started"):
            log("No tunnel URL appeared; stopping the Studio to prevent billing.")
            try:
                s.stop()
            except Exception as e:
                log("automatic stop warning: {}".format(e))
        # Every address route failed. That is the machine's environment, not this account's
        # balance — rotating to another account would hit exactly the same wall, so say so.
        emit({
            "ok": False,
            "error": "no reachable address for the GPU (tunnel gave none within {}s and Lightning's direct port is unavailable)".format(int(url_timeout)),
            "retryable": False,
            "globalFailure": True,
        })


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    try:
        if cmd == "status":
            cmd_status()
        elif cmd == "start":
            cmd_start()
        elif cmd == "stop":
            cmd_stop()
        else:
            emit({"ok": False, "error": "unknown command: {}".format(cmd)})
    except Exception as e:
        if cmd == "start":
            result = {"ok": False, "error": friendly_start_error(e)}
            if hasattr(e, "retryable"):
                result["retryable"] = bool(e.retryable)
        else:
            result = {"ok": False, "error": "{}: {}".format(type(e).__name__, e)}
        emit(result)


if __name__ == "__main__":
    main()
