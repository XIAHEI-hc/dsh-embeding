"""Verify that a live scoped WebSocket is closed after the owning login logs out."""
import asyncio
import json
import os
import time
import uuid

import requests
import websockets

ML = "http://127.0.0.1:9000"
GW = "http://127.0.0.1:8875"


async def main_async():
    session = requests.Session()
    login = session.post(ML + "/api/auth/login", json={
        "username": os.environ.get("ACCEPTANCE_USER_A_USERNAME", "admin"),
        "password": os.environ["ACCEPTANCE_USER_A_PASSWORD"],
    })
    login.raise_for_status()
    session.headers.update({"Origin": "http://localhost:7891", "X-CSRF-Token": session.cookies["ml_csrf"]})
    bootstrap = session.post(ML + "/api/ai/bootstrap", json={"request_id": str(uuid.uuid4())})
    bootstrap.raise_for_status()
    bootstrap_body = bootstrap.json()
    handoff = session.get(GW + "/scope/redeem", params={"ticket": bootstrap_body["scope_ticket"]}, allow_redirects=False)
    if handoff.status_code != 303:
        raise RuntimeError(f"scope redeem failed: {handoff.status_code}")
    scope_cookie = session.cookies.get("dsh_scope")
    if not scope_cookie:
        raise RuntimeError("scope cookie missing")

    started = time.monotonic()
    closed = None
    close_code = None
    close_reason = None
    async with websockets.connect(
        "ws://127.0.0.1:8875/api/remote.mux",
        origin="http://localhost:7891",
        additional_headers={"Cookie": f"dsh_scope={scope_cookie}"},
        open_timeout=15,
        ping_interval=None,
    ) as socket:
        await asyncio.sleep(1)
        logout = session.post(ML + "/api/auth/logout")
        if logout.status_code != 204:
            raise RuntimeError(f"logout failed: {logout.status_code}")
        try:
            await asyncio.wait_for(socket.recv(), timeout=15)
        except websockets.ConnectionClosed as exc:
            closed = True
            close_code = exc.code
            close_reason = exc.reason
        except asyncio.TimeoutError:
            closed = False
    after = session.get(GW + "/", allow_redirects=False)
    if closed is not True:
        raise AssertionError("scoped WebSocket remained open after logout")
    if after.status_code != 403:
        raise AssertionError(f"revoked scope remained usable: HTTP_{after.status_code}")
    print(json.dumps({
        "result": "PASS",
        "logout_status": logout.status_code,
        "context_id": bootstrap_body["context_id"],
        "session_id": bootstrap_body["session_id"],
        "grant_id": bootstrap_body["access_grant_id"],
        "closed_after_logout": closed,
        "close_code": close_code,
        "close_reason": close_reason,
        "close_elapsed_seconds": round(time.monotonic() - started, 2),
        "scoped_http_after_logout_status": after.status_code,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    asyncio.run(main_async())
