"""Run the live acceptance probes and emit one machine-readable summary.

Each probe owns its protocol assertions and credential guard.  This runner
only orchestrates them, preserves their JSON output, and distinguishes a
missing formal credential (BLOCKED) from an implementation failure (FAIL).
It never prints the inherited environment or any secret value.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent
PROBES = (
    ("ab_bootstrap", "acceptance_ab.py"),
    ("native_scope", "acceptance_native_scope.py"),
    ("ws_revoke", "acceptance_ws_revoke.py"),
    ("skill_lifecycle", "acceptance_skill_lifecycle.py"),
    ("restart_recovery", "acceptance_restart.py"),
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--list", action="store_true", help="list probes without executing them")
    parser.add_argument("--timeout", type=float, default=180.0, help="per-probe timeout in seconds")
    return parser.parse_args()


def classify(returncode: int, stdout: str, stderr: str) -> dict:
    # Probe output is intentionally JSON on both PASS and BLOCKED paths. Keep
    # arbitrary assertion/log text in a bounded field for postmortem evidence.
    payload = None
    for text in (stdout, stderr):
        try:
            candidate = json.loads(text)
        except (TypeError, ValueError):
            continue
        if isinstance(candidate, dict) and ("result" in candidate or "reason" in candidate):
            payload = candidate
            break
    if returncode == 0 and isinstance(payload, dict) and payload.get("result") in (None, "PASS"):
        return {"status": "PASS", "payload": payload}
    if returncode == 2 and isinstance(payload, dict) and payload.get("result") == "BLOCKED":
        return {"status": "BLOCKED", "payload": payload}
    detail = (stdout or stderr).strip()
    return {"status": "FAIL", "returncode": returncode, "detail": detail[-2000:]}


def run_probe(name: str, filename: str, timeout: float) -> dict:
    completed = subprocess.run(
        [sys.executable, str(ROOT / filename)],
        cwd=ROOT.parent,
        env=os.environ.copy(),
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    result = classify(completed.returncode, completed.stdout, completed.stderr)
    return {"name": name, "script": filename, **result}


def main() -> int:
    args = parse_args()
    if args.timeout <= 0:
        raise SystemExit("--timeout must be positive")
    if args.list:
        print(json.dumps({"probes": [{"name": name, "script": filename} for name, filename in PROBES]}, indent=2))
        return 0

    results = []
    for name, filename in PROBES:
        try:
            results.append(run_probe(name, filename, args.timeout))
        except subprocess.TimeoutExpired as error:
            results.append({"name": name, "script": filename, "status": "FAIL", "detail": f"timeout after {args.timeout:g}s"})
        except OSError as error:
            results.append({"name": name, "script": filename, "status": "FAIL", "detail": str(error)})

    counts = {status: sum(item["status"] == status for item in results) for status in ("PASS", "BLOCKED", "FAIL")}
    summary = {"result": "FAIL" if counts["FAIL"] else ("BLOCKED" if counts["BLOCKED"] else "PASS"), "counts": counts, "probes": results}
    print(json.dumps(summary, ensure_ascii=True, indent=2))
    return 1 if counts["FAIL"] else (2 if counts["BLOCKED"] else 0)


if __name__ == "__main__":
    raise SystemExit(main())
