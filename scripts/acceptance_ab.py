import json
import os
import uuid
import requests
from acceptance_prereq import BROWSER_ORIGIN, DSH_GATEWAY, MEMORYLAB_BASE, endpoint, require_acceptance_credentials

BASE = MEMORYLAB_BASE

def call(s, method, path, body=None):
    headers = {"Accept": "application/json", "Origin": BROWSER_ORIGIN}
    if body is not None:
        headers["X-CSRF-Token"] = s.cookies.get("ml_csrf", "")
    r = s.request(method, BASE + path, json=body, headers=headers)
    try:
        value = r.json()
    except Exception:
        value = {"detail": r.text[:300]}
    return r.status_code, value

def redeem_scope(s, ticket):
    r = s.get(endpoint(DSH_GATEWAY, "/scope/redeem"), params={"ticket": ticket}, allow_redirects=False)
    return r.status_code, r.headers.get("location"), r.headers.get("set-cookie", "")

def login(username, password):
    s = requests.Session()
    r = s.post(BASE + "/api/auth/login", json={"username": username, "password": password})
    r.raise_for_status()
    return s, r.json()["user"]


def require(condition, message):
    if not condition:
        raise AssertionError(message)

def main():
    require_acceptance_credentials("ACCEPTANCE_USER_A_PASSWORD", "ACCEPTANCE_USER_B_PASSWORD")
    a, au = login(os.environ.get("ACCEPTANCE_USER_A_USERNAME", "admin"), os.environ["ACCEPTANCE_USER_A_PASSWORD"])
    b, bu = login(os.environ.get("ACCEPTANCE_USER_B_USERNAME", "acceptance_b"), os.environ["ACCEPTANCE_USER_B_PASSWORD"])
    ast, ab = call(a, "POST", "/api/ai/bootstrap", {"request_id": "acceptance-a-" + str(uuid.uuid4())})
    bst, bb = call(b, "POST", "/api/ai/bootstrap", {"request_id": "acceptance-b-" + str(uuid.uuid4())})
    require(ast == 200 and bst == 200, f"bootstrap failed: A={ast}, B={bst}")
    require(ab.get("runtime_id") and bb.get("runtime_id"), "bootstrap did not return runtime identity")
    require(ab["runtime_id"] != bb["runtime_id"], "A/B bootstrap selected the same runtime")
    require(ab.get("scope_ticket") and bb.get("scope_ticket"), "scoped bootstrap did not return scope tickets")
    require(ab.get("context_id") != bb.get("context_id"), "A/B contexts must differ")
    require(ab.get("session_id") != bb.get("session_id"), "A/B sessions must differ")
    aact_st, aact = call(a, "GET", "/api/skills/me/activations")
    bact_st, bact = call(b, "GET", "/api/skills/me/activations")
    cross_st, cross = call(b, "POST", "/api/ai/session-associations", {
        "context_id": ab.get("context_id"), "session_id": ab.get("session_id"),
        "request_id": "cross-" + str(uuid.uuid4()), "expected_version": 1,
    })
    require(cross_st in (403, 404), f"cross-user association was not rejected: {cross_st}")
    ar_st, ar_loc, _ = redeem_scope(a, ab.get("scope_ticket"))
    br_st, br_loc, _ = redeem_scope(b, bb.get("scope_ticket"))
    require(ar_st == 303 and br_st == 303, f"scope redeem failed: A={ar_st}, B={br_st}")
    a_ready = a.get("http://127.0.0.1:8875/embed/health/ready")
    b_ready = b.get("http://127.0.0.1:8875/embed/health/ready")
    cross_ready = requests.get("http://127.0.0.1:8875/embed/health/ready")
    b_with_a = requests.Session()
    scope_cookie_name = next((c.name for c in a.cookies if c.name.startswith("dsh")), "dsh_scope")
    scope_cookie_value = a.cookies.get(scope_cookie_name)
    b_with_a.cookies.set(scope_cookie_name, scope_cookie_value, domain="127.0.0.1", path="/")
    b_a_ready = b_with_a.get("http://127.0.0.1:8875/embed/health/ready")
    a_root = a.get("http://127.0.0.1:8875/", allow_redirects=False)
    b_root = b.get("http://127.0.0.1:8875/", allow_redirects=False)
    b_a_root = b_with_a.get("http://127.0.0.1:8875/", allow_redirects=False)
    unauth_root = requests.get("http://127.0.0.1:8875/", allow_redirects=False)
    require(a_ready.status_code == 200 and b_ready.status_code == 200, "valid scopes cannot reach their runtimes")
    require(cross_ready.status_code in (401, 403), "unauthenticated gateway request was accepted")
    require(b_a_ready.status_code == 403, "B accepted A's scope cookie")
    require(a_root.status_code == 200 and b_root.status_code == 200, "valid scoped root failed")
    require(b_a_root.status_code == 403, "B's copied scope reached A's root")
    require(unauth_root.status_code in (401, 403), "unauthenticated root was accepted")
    print(json.dumps({
        "result": "PASS",
        "a_user": au["id"], "b_user": bu["id"],
        "a_bootstrap_status": ast, "b_bootstrap_status": bst,
        "a_runtime": ab.get("runtime_id"), "b_runtime": bb.get("runtime_id"),
        "a_context": ab.get("context_id"), "b_context": bb.get("context_id"),
        "a_session": ab.get("session_id"), "b_session": bb.get("session_id"),
        "a_grant": ab.get("access_grant_id"), "b_grant": bb.get("access_grant_id"),
        "a_activations_status": aact_st, "b_activations_status": bact_st,
        "a_activations_count": len(aact.get("items", [])),
        "b_activations_count": len(bact.get("items", [])),
        "cross_association_status": cross_st,
        "cross_association_code": cross.get("code"),
        "cross_association_detail": cross.get("detail"),
        "a_scope_redeem_status": ar_st, "b_scope_redeem_status": br_st,
        "a_scope_location": ar_loc, "b_scope_location": br_loc,
        "a_ready_status": a_ready.status_code, "b_ready_status": b_ready.status_code,
        "unauth_ready_status": cross_ready.status_code,
        "b_with_a_scope_ready_status": b_a_ready.status_code,
        "a_root_status": a_root.status_code, "b_root_status": b_root.status_code,
        "b_with_a_scope_root_status": b_a_root.status_code,
        "unauth_root_status": unauth_root.status_code,
        "scope_cookie_names": sorted(c.name for c in a.cookies),
        "a_bootstrap_keys": sorted(ab.keys()),
        "b_bootstrap_keys": sorted(bb.keys()),
    }, ensure_ascii=False, indent=2))

if __name__ == "__main__":
    main()
