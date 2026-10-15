"""Reversible live restart probe for the A runtime, gateway and Memory Lab.

The probe only restarts containers; it never removes volumes or recreates the
database. Passwords are read from environment variables and are not printed.
"""
import json
import os
import subprocess
import time
import uuid

import requests
from acceptance_prereq import require_acceptance_credentials

ML = "http://127.0.0.1:9000"
GW = "http://127.0.0.1:8875"


def docker(*args):
    return subprocess.check_output(
        ["wsl.exe", "-d", "Ubuntu", "--exec", "docker", *args],
        stderr=subprocess.DEVNULL, text=True,
    ).strip()


def runner_secret():
    return docker("exec", "dsh-workbench-dsh-user-a-1", "cat", "/private/runner-client-secret").splitlines()[-1].strip()


def wait_http(url, expected=200, timeout=45):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            response = requests.get(url, timeout=3)
            last = response.status_code
            if response.status_code == expected:
                return response
        except requests.RequestException as exc:
            last = type(exc).__name__
        time.sleep(1)
    raise RuntimeError(f"timeout waiting for {url}: last={last}")


def wait_session_response(session, url, expected=200, timeout=45):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            response = session.get(url, allow_redirects=False, timeout=3)
            last = response.status_code
            if response.status_code == expected:
                return response
        except requests.RequestException as exc:
            last = type(exc).__name__
        time.sleep(1)
    raise RuntimeError(f"timeout waiting for scoped {url}: last={last}")


def login_and_bootstrap():
    session = requests.Session()
    response = session.post(ML + "/api/auth/login", json={
        "username": os.environ.get("ACCEPTANCE_USER_A_USERNAME", "admin"),
        "password": os.environ["ACCEPTANCE_USER_A_PASSWORD"],
    })
    response.raise_for_status()
    session.headers.update({"Origin": "http://localhost:7891", "X-CSRF-Token": session.cookies["ml_csrf"]})
    response = session.post(ML + "/api/ai/bootstrap", json={"request_id": str(uuid.uuid4())})
    response.raise_for_status()
    return session, response.json()


def redeem(session, ticket):
    response = session.get(GW + "/scope/redeem", params={"ticket": ticket}, allow_redirects=False)
    if response.status_code != 303:
        raise RuntimeError(f"scope redeem failed: {response.status_code}")


def catalog(scope):
    secret = runner_secret()
    return requests.post(ML + "/api/skills/runtime/v1/catalog", headers={
        "Authorization": "Bearer " + secret,
        "X-DSH-Instance-ID": "memorylab-local-dsh",
        "X-DSH-RUNTIME-ID": "runner-a",
    }, json={"protocol_version": "1.0", "request_id": str(uuid.uuid4()), **scope})


def restart(container):
    docker("restart", container)


def main():
    require_acceptance_credentials("ACCEPTANCE_USER_A_PASSWORD")
    session, bootstrap = login_and_bootstrap()
    scope = {"context_id": bootstrap["context_id"], "session_id": bootstrap["session_id"],
             "access_grant_id": bootstrap["access_grant_id"]}
    redeem(session, bootstrap["scope_ticket"])
    before_root = session.get(GW + "/", allow_redirects=False)
    before_catalog = catalog(scope)

    restart("dsh-workbench-dsh-user-a-1")
    wait_http(GW + "/health")
    after_runner_root = wait_session_response(session, GW + "/")

    restart("dsh-workbench-dsh-gateway-1")
    wait_http(GW + "/health")
    after_gateway_root = wait_session_response(session, GW + "/")

    restart("private_mem_lab-backend-1")
    wait_http(ML + "/api/platform/health")
    after_backend_root = wait_session_response(session, GW + "/")
    after_catalog = catalog(scope)
    activations = session.get(ML + "/api/skills/me/activations")

    print(json.dumps({
        "before_root_status": before_root.status_code,
        "before_catalog_status": before_catalog.status_code,
        "before_catalog_items": len(before_catalog.json().get("items", [])),
        "after_runner_root_status": after_runner_root.status_code,
        "after_gateway_root_status": after_gateway_root.status_code,
        "after_backend_root_status": after_backend_root.status_code,
        "after_catalog_status": after_catalog.status_code,
        "after_catalog_items": len(after_catalog.json().get("items", [])),
        "after_activation_status": activations.status_code,
        "after_activation_sync": [
            {"sync_state": item.get("sync_state"), "effective_enabled": item.get("effective_enabled")}
            for item in activations.json().get("items", [])
        ],
        "health": {
            "gateway": wait_http(GW + "/health").status_code,
            "memorylab": wait_http(ML + "/api/platform/health").status_code,
        },
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
