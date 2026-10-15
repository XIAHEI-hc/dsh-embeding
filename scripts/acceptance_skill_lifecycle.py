"""Run a reversible live disable/resolve/re-enable/ACK probe.

Credentials are supplied through environment variables; the runtime secret is
read inside the runner container and never printed.
"""
import json
import os
import subprocess
import uuid
from datetime import datetime, timezone

import requests
from acceptance_prereq import require_acceptance_credentials

BASE = os.environ.get("MEMORYLAB_BASE", "http://127.0.0.1:9000")
RUNTIME = os.environ.get("RUNTIME_ID", "runner-a")
INSTANCE = os.environ.get("DSH_INSTANCE_ID", "memorylab-local-dsh")


def login():
    s = requests.Session()
    r = s.post(BASE + "/api/auth/login", json={
        "username": os.environ.get("ACCEPTANCE_USER_A_USERNAME", "admin"),
        "password": os.environ["ACCEPTANCE_USER_A_PASSWORD"],
    })
    r.raise_for_status()
    s.headers.update({"Origin": "http://localhost:7891", "X-CSRF-Token": s.cookies["ml_csrf"]})
    bootstrap = s.post(BASE + "/api/ai/bootstrap", json={"request_id": str(uuid.uuid4())})
    bootstrap.raise_for_status()
    return s, bootstrap.json()


def container_name():
    return os.environ.get("DSH_RUNNER_A_CONTAINER", "deploy-dsh-user-a-1")


def runtime_secret():
    raw = subprocess.check_output([
        "wsl.exe", "-d", "Ubuntu", "--exec", "docker", "exec",
        container_name(), "cat", "/private/runner-client-secret",
    ], stderr=subprocess.DEVNULL, text=True)
    return raw.strip().splitlines()[-1].strip()


def runtime_call(secret, path, body):
    return requests.post(BASE + "/api/skills/runtime/v1/" + path, headers={
        "Authorization": "Bearer " + secret,
        "X-DSH-Instance-ID": INSTANCE,
        "X-DSH-RUNTIME-ID": RUNTIME,
    }, json={"protocol_version": "1.0", "request_id": str(uuid.uuid4()), **body})


def main():
    require_acceptance_credentials("ACCEPTANCE_USER_A_PASSWORD")
    s, bootstrap = login()
    activation_items = s.get(BASE + "/api/skills/me/activations").json().get("items", [])
    activation = next((item for item in activation_items if item.get("desired_enabled") is True), None)
    if activation is None:
        raise RuntimeError("没有找到可执行生命周期探针的 active skill activation")
    skill_id = activation["skill_id"]
    scope = {"context_id": bootstrap["context_id"], "session_id": bootstrap["session_id"],
             "access_grant_id": bootstrap["access_grant_id"]}
    secret = runtime_secret()
    disabled = s.post(f"{BASE}/api/skills/{skill_id}/disable")
    catalog_disabled = runtime_call(secret, "catalog", scope)
    item_disabled = catalog_disabled.json()["items"][0]
    resolve_disabled = runtime_call(secret, "resolve", {**scope, **{
        "activation_id": item_disabled["activation_id"], "version_id": item_disabled["version_id"],
        "generation": item_disabled["generation"], "archive_sha256": item_disabled["archive_sha256"],
    }})
    enabled = s.post(f"{BASE}/api/skills/{skill_id}/enable", json={
        "version_id": activation["version_id"], "target": "memorylab-dsh",
    })
    current_items = s.get(BASE + "/api/skills/me/activations").json().get("items", [])
    current = next((item for item in current_items if item.get("skill_id") == skill_id), None)
    if current is None:
        raise RuntimeError("重新启用后找不到原 skill activation")
    current_scope = {**scope, "activation_id": current["id"], "version_id": current["version_id"],
                     "generation": current["generation"], "archive_sha256": current["archive_sha256"]}
    catalog_pending = runtime_call(secret, "catalog", scope)
    revision = catalog_pending.json()["catalog_revision"]
    acknowledged = runtime_call(secret, "ack", {**current_scope, "ack_id": str(uuid.uuid4()),
        "status": "installed", "provider_revision": revision})
    resolved = runtime_call(secret, "resolve", current_scope)
    print(json.dumps({
        "disable_status": disabled.status_code,
        "disabled_desired_enabled": item_disabled["desired_enabled"],
        "disabled_ack_status": item_disabled["ack_status"],
        "resolve_after_disable_status": resolve_disabled.status_code,
        "resolve_after_disable_error": resolve_disabled.json().get("error"),
        "enable_status": enabled.status_code,
        "generation_after_enable": current["generation"],
        "ack_status": acknowledged.status_code,
        "resolve_after_ack_status": resolved.status_code,
        "resolved_runtime_name": resolved.json().get("runtime_name"),
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
