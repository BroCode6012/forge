#!/usr/bin/env python3
"""Offline regression checks for Lightning Studio startup handling."""

import json
import os
import subprocess
import sys
import tempfile


ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SRC = os.path.join(ROOT, "src")
if SRC not in sys.path:
    sys.path.insert(0, SRC)

import lightning_compat as compat


class FakeMachine:
    slug = "lit-t4-1"

    def __str__(self):
        return "T4"


class FakeStudio:
    def __init__(self, status="Stopped"):
        self._status = status
        self.stop_calls = 0
        self.start_calls = 0
        self.setup_calls = 0

    @property
    def status(self):
        return self._status

    def start(self, **_kwargs):
        self.start_calls += 1
        self._status = "Running"

    def stop(self):
        self.stop_calls += 1
        self._status = "Stopped"

    def _setup(self):
        self.setup_calls += 1


original_raw_start = compat._raw_start_request
try:
    payment_body = json.dumps({
        "code": 7,
        "message": (
            "creating cloud space instance: rpc error: code = PermissionDenied "
            "desc = Free-tier users must have a verified payment method before starting compute"
        ),
    })
    compat._raw_start_request = lambda *_args, **_kwargs: {
        "available": True,
        "ok": False,
        "status": 403,
        "body": payment_body,
    }
    blocked = FakeStudio()
    try:
        compat.start_studio_compat(blocked, FakeMachine(), timeout=1)
        raise AssertionError("payment-method rejection must fail")
    except compat.LightningStartError as exc:
        assert "verified payment method" in str(exc).lower()
        assert exc.retryable is False
        assert blocked.stop_calls == 0
        assert compat.status_name(blocked) == "Stopped"

    started = FakeStudio()

    def raw_success(studio, *_args, **_kwargs):
        studio._status = "Running"
        return {"available": True, "ok": True, "status": 200, "body": "{}"}

    compat._raw_start_request = raw_success
    info = compat.start_studio_compat(started, FakeMachine(), timeout=1)
    assert info["started"] is True
    assert info["method"] == "rest"
    assert started.start_calls == 0
    assert started.setup_calls == 1

    fallback = FakeStudio()
    compat._raw_start_request = lambda *_args, **_kwargs: {
        "available": False,
        "ok": False,
        "error": "private SDK metadata unavailable",
    }
    info = compat.start_studio_compat(fallback, FakeMachine(), timeout=1)
    assert info["started"] is True
    assert info["method"] == "sdk"
    assert fallback.start_calls == 1

    existing = FakeStudio("Running")
    info = compat.start_studio_compat(existing, FakeMachine(), timeout=1)
    assert info["started"] is False
    assert info["already_running"] is True
    assert existing.start_calls == 0

    checker = open(
        os.path.join(ROOT, "tools", "check-lightning-studio.py"),
        "r",
        encoding="utf-8",
    ).read()
    assert "not started (Studio remains {})" in checker
    assert "left untouched (initial state: {})" in checker

    gpu_controller = open(
        os.path.join(ROOT, "src", "vision", "vision-gpu.js"),
        "r",
        encoding="utf-8",
    ).read()
    assert "r.retryable === false" in gpu_controller

    lightning_box = open(
        os.path.join(ROOT, "src", "vision", "lightning-box.js"),
        "r",
        encoding="utf-8",
    ).read()
    assert "startedByApp" in lightning_box
    assert "stopping the Studio to prevent billing" in lightning_box

    controller = open(
        os.path.join(ROOT, "src", "lightning-control.py"),
        "r",
        encoding="utf-8",
    ).read()
    assert 'os.environ.get("LIGHTNING_MACHINE", "T4")' in controller
    assert "machine switch failed:" in controller
    assert 'start_info["method"] = "machine-switch"' in controller

    rotation = open(
        os.path.join(ROOT, "src", "vision", "lightning-rotation.js"),
        "r",
        encoding="utf-8",
    ).read()
    assert "a.machine || 'T4'" in rotation
    assert "s.lastError = null" in rotation

    main_process = open(
        os.path.join(ROOT, "main.js"),
        "r",
        encoding="utf-8",
    ).read()
    assert "rotation.markHealthy(acct)" in main_process
    assert "rotation.markExhausted(acct" in main_process

    # The Lightning backend must stay one logical self-hosted lane even when the
    # user's root env also contains several DashScope keys. This child process
    # exercises both config-time routing and ai-provider's five-second env refresh.
    with tempfile.TemporaryDirectory() as tmp:
        env_path = os.path.join(tmp, "lightning-runtime.env")
        with open(env_path, "w", encoding="utf-8") as fh:
            fh.write(
                "\n".join(
                    [
                        "VISION_BACKEND=lightning",
                        "LIGHTNING_VISION_URL=https://lightning.invalid/v1",
                        "LIGHTNING_VISION_MODEL=qwen2.5-vl",
                        "LIGHTNING_VISION_API_KEY=",
                        "QWEN_VISION_API_KEY=dash-shared-a,dash-shared-b,dash-shared-c",
                        "QWEN_IMAGE_API_KEY=dash-image-a,dash-image-b",
                        "QWEN_OMNI_API_KEY=dash-omni-a,dash-omni-b",
                        "QWEN_VISION_MAX_CONCURRENCY=",
                        "CF_TUNNEL_TOKEN=test-token",
                    ]
                )
                + "\n"
            )
        node_script = r"""
const config = require('./src/settings/config');
const provider = require('./src/brain/ai-provider');
const status = provider.getQwenVisionStatus();
const lightning = {
  sharedKeys: status.sharedKeys,
  imageKeys: status.imageKeys,
  omniKeys: status.omniKeys,
  endpoint: status.endpoint,
  concurrency: process.env.QWEN_VISION_MAX_CONCURRENCY,
  imageMatchesShared: process.env.QWEN_IMAGE_API_KEY === process.env.QWEN_VISION_API_KEY,
  omniMatchesShared: process.env.QWEN_OMNI_API_KEY === process.env.QWEN_VISION_API_KEY,
};
process.env.VISION_BACKEND = 'dashscope';
config.resolveVisionBackend();
const count = (value) => String(value || '').split(',').map((v) => v.trim()).filter(Boolean).length;
const restored = {
  sharedKeys: count(process.env.QWEN_VISION_API_KEY),
  imageKeys: count(process.env.QWEN_IMAGE_API_KEY),
  omniKeys: count(process.env.QWEN_OMNI_API_KEY),
};
console.log('@@LIGHTNING_RUNTIME@@' + JSON.stringify({ lightning, restored }));
"""
        child_env = os.environ.copy()
        child_env["YTA_USER_ENV_PATH"] = env_path
        child_env["YTA_USER_DATA_DIR"] = tmp
        result = subprocess.run(
            ["node", "-e", node_script],
            cwd=ROOT,
            env=child_env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=60,
            check=False,
        )
        assert result.returncode == 0, result.stderr or result.stdout
        marker = next(
            (line for line in result.stdout.splitlines() if line.startswith("@@LIGHTNING_RUNTIME@@")),
            None,
        )
        assert marker, result.stdout
        runtime = json.loads(marker[len("@@LIGHTNING_RUNTIME@@"):])
        lightning = runtime["lightning"]
        assert lightning["sharedKeys"] == 1
        assert lightning["imageKeys"] == 1
        assert lightning["omniKeys"] == 1
        assert lightning["endpoint"] == "https://lightning.invalid/v1"
        assert lightning["concurrency"] == "4"
        assert lightning["imageMatchesShared"] is True
        assert lightning["omniMatchesShared"] is True
        assert runtime["restored"] == {
            "sharedKeys": 3,
            "imageKeys": 2,
            "omniKeys": 2,
        }
finally:
    compat._raw_start_request = original_raw_start

print("OK: Lightning startup, ownership, single-lane routing, concurrency, fallback, and retry policy verified")
