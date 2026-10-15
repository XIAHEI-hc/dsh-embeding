"""Live native DSH RPC isolation probe for two Memory Lab users.

This deliberately speaks the official Remote Stream Mux protocol instead of
calling private extension routes.  It proves that session, fork, workspace
file, and terminal operations are scoped by the gateway-selected runner.
Credentials are read from environment variables and never printed.
"""
import asyncio
import json
import os
import uuid

import requests
import websockets

ML = os.environ.get("MEMORYLAB_BASE", "http://127.0.0.1:9000")
GW = os.environ.get("DSH_GATEWAY", "http://127.0.0.1:8875")
WS = GW.replace("http://", "ws://").replace("https://", "wss://") + "/api/remote.mux"


def login(username: str, password: str):
    session = requests.Session()
    response = session.post(ML + "/api/auth/login", json={"username": username, "password": password})
    response.raise_for_status()
    session.headers.update({"Origin": "http://localhost:7891", "X-CSRF-Token": session.cookies["ml_csrf"]})
    bootstrap = session.post(ML + "/api/ai/bootstrap", json={"request_id": str(uuid.uuid4())})
    bootstrap.raise_for_status()
    scope = bootstrap.json()
    redeem = session.get(GW + "/scope/redeem", params={"ticket": scope["scope_ticket"]}, allow_redirects=False)
    if redeem.status_code != 303:
        raise RuntimeError(f"scope redeem failed: HTTP_{redeem.status_code}")
    cookie = session.cookies.get("dsh_scope")
    if not cookie:
        raise RuntimeError("scope cookie missing")
    return session, scope, cookie


async def remote_call(cookie: str, endpoint: str, args: dict):
    stream_id = str(uuid.uuid4())
    values = []
    async with websockets.connect(
        WS,
        origin="http://localhost:7891",
        additional_headers={"Cookie": f"dsh_scope={cookie}"},
        open_timeout=15,
        ping_interval=None,
    ) as socket:
        await socket.send(json.dumps({
            "type": "open", "streamId": stream_id, "endpoint": endpoint,
            "payload": {"args": args},
        }))
        while True:
            frame = json.loads(await asyncio.wait_for(socket.recv(), timeout=20))
            if frame.get("streamId") != stream_id:
                continue
            if frame["type"] == "item":
                values.append(frame.get("value"))
            elif frame["type"] == "end":
                return {"ok": True, "items": values}
            elif frame["type"] == "error":
                return {"ok": False, "error": frame.get("error")}
            else:
                raise RuntimeError(f"unexpected Remote frame type: {frame.get('type')}")


def require(condition, message):
    if not condition:
        raise AssertionError(message)


async def main_async():
    _, a_scope, a_cookie = login(
        os.environ.get("ACCEPTANCE_USER_A_USERNAME", "admin"),
        os.environ["ACCEPTANCE_USER_A_PASSWORD"],
    )
    _, b_scope, b_cookie = login(
        os.environ.get("ACCEPTANCE_USER_B_USERNAME", "acceptance_b"),
        os.environ["ACCEPTANCE_USER_B_PASSWORD"],
    )
    a_session = a_scope["session_id"]
    b_session = b_scope["session_id"]
    a_list = await remote_call(a_cookie, "session/list", {})
    b_list = await remote_call(b_cookie, "session/list", {})
    require(a_list["ok"] and b_list["ok"], "native session/list failed for a valid scope")
    a_ids = {item.get("id") or item.get("sessionId") for item in a_list["items"][0].get("items", [])}
    b_ids = {item.get("id") or item.get("sessionId") for item in b_list["items"][0].get("items", [])}
    require(a_session in a_ids, "A cannot list its bootstrap session")
    require(b_session in b_ids, "B cannot list its bootstrap session")
    require(a_session not in b_ids and b_session not in a_ids, "A/B session list leaked a foreign session")

    a_projection = await remote_call(a_cookie, "session/projections", {"sessionId": a_session})
    require(a_projection["ok"], "A cannot read its own session projections")
    b_projection_a = await remote_call(b_cookie, "session/projections", {"sessionId": a_session})
    require(not b_projection_a["ok"], "B read A's session projections")

    a_rename = await remote_call(a_cookie, "session/rename", {"sessionId": a_session, "title": "scope-probe-a"})
    require(a_rename["ok"], "A cannot rename its own session")
    b_rename_a = await remote_call(b_cookie, "session/rename", {"sessionId": a_session, "title": "foreign-write"})
    require(not b_rename_a["ok"], "B renamed A's session")

    a_fork = await remote_call(a_cookie, "session/fork", {"sessionId": a_session})
    require(a_fork["ok"] and a_fork["items"], "A fork did not return a child session")
    child = a_fork["items"][0].get("sessionId")
    require(isinstance(child, str) and child, "fork response has no child session id")
    b_fork_a = await remote_call(b_cookie, "session/fork", {"sessionId": a_session})
    require(not b_fork_a["ok"], "B forked A's session")

    a_files = await remote_call(a_cookie, "workspaceFiles/list", {"workspaceFileScopeId": a_session, "path": "."})
    require(a_files["ok"], "A cannot list its own workspace")
    b_files_a = await remote_call(b_cookie, "workspaceFiles/list", {"workspaceFileScopeId": a_session, "path": "."})
    require(not b_files_a["ok"], "B read A's workspace files")
    b_terminal_a = await remote_call(b_cookie, "terminal/list", {"sessionId": a_session})
    require(not b_terminal_a["ok"], "B listed A's terminals")

    print(json.dumps({
        "result": "PASS",
        "a_session": a_session,
        "b_session": b_session,
        "a_list_status": a_list["ok"],
        "b_list_status": b_list["ok"],
        "a_projection_status": a_projection["ok"],
        "b_projection_a_rejected": not b_projection_a["ok"],
        "a_rename_status": a_rename["ok"],
        "b_rename_a_rejected": not b_rename_a["ok"],
        "a_fork_status": a_fork["ok"],
        "b_fork_a_rejected": not b_fork_a["ok"],
        "a_workspace_list_status": a_files["ok"],
        "b_workspace_read_a_rejected": not b_files_a["ok"],
        "b_terminal_read_a_rejected": not b_terminal_a["ok"],
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    asyncio.run(main_async())
