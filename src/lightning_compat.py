#!/usr/bin/env python3
"""Compatibility helpers for starting Lightning Studios safely.

The Lightning SDK currently retries and wraps some Studio-start failures in a
generic 400/405 ApiException.  Calling the same start endpoint with the minimal
documented compute payload preserves the useful API message (for example, the
free-tier verified-payment-method requirement).

This module keeps that workaround in one place so health checks, provisioning,
and normal builds all behave the same way.
"""

import json
import time
from urllib import error as urlerror
from urllib import parse as urlparse
from urllib import request as urlrequest


class LightningStartError(RuntimeError):
    """A Studio start failure with retryability metadata for the Node controller."""

    def __init__(self, message, status_code=None, retryable=True, started=False):
        super().__init__(message)
        self.status_code = status_code
        self.retryable = bool(retryable)
        self.started = bool(started)


def status_name(studio):
    """Return a stable external Studio status string."""
    try:
        value = getattr(studio, "status", "")
    except Exception:
        return "Unknown"
    if hasattr(value, "value"):
        value = value.value
    text = str(value or "Unknown").strip()
    if "." in text:
        text = text.rsplit(".", 1)[-1]
    return text or "Unknown"


def is_running(studio):
    return status_name(studio).lower() == "running"


def _json_message(body):
    text = str(body or "").strip()
    if not text:
        return ""
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            for key in ("message", "error", "detail", "reason"):
                value = parsed.get(key)
                if value:
                    if isinstance(value, dict):
                        return str(value.get("message") or value)
                    return str(value)
    except Exception:
        pass
    return text


def _exception_details(value):
    status_code = getattr(value, "status", None) or getattr(value, "status_code", None)
    body = getattr(value, "body", None)
    reason = getattr(value, "reason", None)
    message = _json_message(body) or str(reason or value or "Lightning Studio start failed")
    try:
        status_code = int(status_code) if status_code is not None else None
    except Exception:
        status_code = None
    return status_code, message


def _friendly_start_failure(status_code, message):
    raw = str(message or "Lightning Studio start failed").strip()
    low = raw.lower()

    if "verified payment method" in low:
        return (
            "Lightning blocked GPU startup: this free-tier account needs a verified "
            "payment method. Open Lightning.ai Billing, add or verify a payment method "
            "for this account, then click Check again. No Studio was started."
        ), False
    if "insufficient balance" in low or "not enough balance" in low:
        return (
            "Lightning blocked GPU startup because this account has insufficient "
            "credit or balance. Check its Lightning billing/credits, then reset or "
            "replace the account in the rotation pool."
        ), False
    if status_code == 401 or "unauthorized" in low or "invalid api key" in low:
        return (
            "Lightning authentication failed. Re-enter the account User ID and API key "
            "from Programmatic Login, then try again."
        ), False
    if status_code == 403 or "permissiondenied" in low or "permission denied" in low:
        return "Lightning denied permission to start this Studio: {}".format(raw), False
    if status_code == 404 or "not found" in low or "does not exist" in low:
        return (
            "Lightning could not find the configured Studio/teamspace. Check the Studio "
            "name, teamspace, and username: {}".format(raw)
        ), False
    if status_code == 405 or "method not allowed" in low:
        return (
            "Lightning rejected the Studio start request (HTTP 405). This is an API/SDK "
            "compatibility failure, not a vision-model failure. Update the Lightning "
            "integration or retry after Lightning restores the start endpoint."
        ), False
    if status_code == 400 or "bad request" in low:
        return "Lightning rejected the Studio start request: {}".format(raw), False
    if status_code == 429 or "too many requests" in low or "rate limit" in low:
        return "Lightning is rate-limiting Studio startup: {}".format(raw), True
    if "capacity" in low or "temporarily unavailable" in low or status_code in (502, 503, 504):
        return "Lightning has no available GPU capacity right now: {}".format(raw), True

    prefix = "Lightning Studio start failed"
    if status_code:
        prefix += " (HTTP {})".format(status_code)
    return "{}: {}".format(prefix, raw), True


def friendly_start_error(value):
    """Convert SDK/raw exceptions into an actionable, secret-safe message."""
    if isinstance(value, LightningStartError):
        return str(value)
    status_code, message = _exception_details(value)
    friendly, _ = _friendly_start_failure(status_code, message)
    return friendly


def _machine_slug(machine):
    slug = getattr(machine, "slug", None)
    if slug:
        return str(slug)
    text = str(machine or "").strip()
    try:
        from lightning_sdk import Machine
        parsed = Machine.from_str(text)
        if getattr(parsed, "slug", None):
            return str(parsed.slug)
    except Exception:
        pass
    # Keep the requested value if a future SDK introduces a new machine name.
    return text


def _raw_start_request(studio, machine, interruptible=False, max_runtime=None, timeout=60):
    """Start through Lightning's REST endpoint.

    Returns a result dictionary instead of raising so callers can decide whether
    to fall back to the public SDK. Authorization headers are never returned.
    """
    try:
        client = studio._studio_api._client.api_client
        host = str(client.configuration.host).rstrip("/")
        teamspace_id = str(studio._teamspace.id)
        studio_id = str(studio._studio.id)
        default_headers = dict(client.default_headers or {})
    except Exception as exc:
        return {"available": False, "ok": False, "error": str(exc)}

    slug = _machine_slug(machine)
    if not slug:
        return {"available": False, "ok": False, "error": "machine slug unavailable"}

    compute = {"name": slug}
    if interruptible:
        compute["spot"] = True
    if max_runtime is not None:
        compute["requestedRunDurationSeconds"] = str(int(max_runtime))
    payload = json.dumps({"computeConfig": compute}).encode("utf-8")
    endpoint = "{}/v1/projects/{}/cloudspaces/{}/start".format(
        host,
        urlparse.quote(teamspace_id, safe=""),
        urlparse.quote(studio_id, safe=""),
    )
    headers = {
        str(key): str(value)
        for key, value in default_headers.items()
        if str(key).lower() in ("authorization", "user-agent")
    }
    headers["Accept"] = "application/json"
    headers["Content-Type"] = "application/json"
    req = urlrequest.Request(endpoint, data=payload, headers=headers, method="POST")

    try:
        with urlrequest.urlopen(req, timeout=max(5, float(timeout))) as response:
            body = response.read().decode("utf-8", errors="replace")
            return {
                "available": True,
                "ok": 200 <= int(response.status) < 300,
                "status": int(response.status),
                "body": body,
            }
    except urlerror.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        return {
            "available": True,
            "ok": False,
            "status": int(exc.code),
            "body": body,
        }
    except (urlerror.URLError, TimeoutError, OSError) as exc:
        return {
            "available": False,
            "ok": False,
            "error": "{}: {}".format(type(exc).__name__, exc),
        }


def _wait_until(studio, wanted, timeout, log=None, accepted_start=False):
    deadline = time.monotonic() + max(1, float(timeout))
    wanted_lower = {str(item).lower() for item in wanted}
    last = None
    stopped_since = None

    while time.monotonic() < deadline:
        current = status_name(studio)
        low = current.lower()
        if current != last and log:
            log("Lightning Studio state: {}".format(current))
            last = current
        if low in wanted_lower:
            return current
        if low == "failed":
            raise LightningStartError(
                "Lightning Studio entered the Failed state while starting.",
                retryable=True,
                started=accepted_start,
            )
        if accepted_start and low == "stopped":
            if stopped_since is None:
                stopped_since = time.monotonic()
            elif time.monotonic() - stopped_since >= 12:
                raise LightningStartError(
                    "Lightning accepted the start request but the Studio remained stopped.",
                    retryable=True,
                    started=True,
                )
        else:
            stopped_since = None
        time.sleep(2)

    raise LightningStartError(
        "Timed out after {}s waiting for Lightning Studio state {} (last state: {}).".format(
            int(timeout), "/".join(wanted), status_name(studio)
        ),
        retryable=True,
        started=accepted_start,
    )


def _stop_partial_start(studio, log=None):
    try:
        current = status_name(studio).lower()
        if current in ("pending", "running", "failed"):
            if log:
                log("Start did not complete cleanly; stopping the Studio to prevent billing...")
            studio.stop()
            return True
    except Exception:
        pass
    return False


def start_studio_compat(
    studio,
    machine,
    timeout=600,
    interruptible=False,
    max_runtime=None,
    log=None,
):
    """Start a Studio and return ownership/method metadata.

    The minimal REST request is preferred because it exposes Lightning's real
    rejection message. The public SDK remains the fallback if private client
    metadata or the REST route is unavailable.
    """
    initial = status_name(studio)
    initial_low = initial.lower()
    if initial_low == "running":
        return {
            "started": False,
            "already_running": True,
            "method": "existing",
            "initial_status": initial,
        }
    if initial_low == "pending":
        _wait_until(studio, ("Running",), timeout, log=log, accepted_start=False)
        return {
            "started": False,
            "already_running": True,
            "method": "existing-pending",
            "initial_status": initial,
        }
    if initial_low == "stopping":
        _wait_until(studio, ("Stopped",), min(float(timeout), 180), log=log)
    elif initial_low != "stopped":
        raise LightningStartError(
            "Cannot start Lightning Studio from state {}.".format(initial),
            retryable=True,
        )

    accepted = False
    raw = _raw_start_request(
        studio,
        machine,
        interruptible=interruptible,
        max_runtime=max_runtime,
        timeout=min(max(float(timeout), 10), 90),
    )
    if raw.get("available") and raw.get("ok"):
        accepted = True
        try:
            _wait_until(studio, ("Running",), timeout, log=log, accepted_start=True)
            setup = getattr(studio, "_setup", None)
            if callable(setup):
                setup()
            return {
                "started": True,
                "already_running": False,
                "method": "rest",
                "initial_status": initial,
            }
        except Exception:
            _stop_partial_start(studio, log=log)
            raise

    raw_status = raw.get("status")
    raw_message = _json_message(raw.get("body")) or raw.get("error") or ""
    # A real policy/account rejection is authoritative. Do not let the SDK
    # replace it with the less useful generic ApiException shown in the UI.
    if raw.get("available") and raw_status not in (404, 405, 501):
        friendly, retryable = _friendly_start_failure(raw_status, raw_message)
        raise LightningStartError(
            friendly,
            status_code=raw_status,
            retryable=retryable,
            started=False,
        )

    # Compatibility fallback for SDK versions/endpoints where raw metadata is
    # unavailable or the route itself changed.
    try:
        kwargs = {"machine": machine}
        if interruptible:
            kwargs["interruptible"] = True
        if max_runtime is not None:
            kwargs["max_runtime"] = int(max_runtime)
        try:
            studio.start(**kwargs)
        except TypeError:
            try:
                studio.start(machine=machine)
            except TypeError:
                studio.start()
        accepted = status_name(studio).lower() in ("pending", "running")
        if not is_running(studio):
            _wait_until(studio, ("Running",), timeout, log=log, accepted_start=accepted)
        return {
            "started": True,
            "already_running": False,
            "method": "sdk",
            "initial_status": initial,
        }
    except Exception as exc:
        # The SDK can throw after the API accepted startup. Recover that state
        # instead of falsely reporting a total failure.
        current = status_name(studio).lower()
        if current in ("pending", "running"):
            try:
                if current != "running":
                    _wait_until(studio, ("Running",), timeout, log=log, accepted_start=True)
                return {
                    "started": True,
                    "already_running": False,
                    "method": "sdk-recovered",
                    "initial_status": initial,
                }
            except Exception:
                _stop_partial_start(studio, log=log)
                raise
        _stop_partial_start(studio, log=log)
        status_code, message = _exception_details(exc)
        friendly, retryable = _friendly_start_failure(status_code, message)
        if raw_status in (404, 405, 501) and raw_message:
            raw_friendly, raw_retryable = _friendly_start_failure(raw_status, raw_message)
            if status_code is None:
                friendly, retryable = raw_friendly, raw_retryable
        raise LightningStartError(
            friendly,
            status_code=status_code or raw_status,
            retryable=retryable,
            started=accepted,
        ) from exc
