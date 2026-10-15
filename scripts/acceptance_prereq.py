"""Shared guards for live acceptance scripts.

The live probes must never guess passwords or silently turn a missing login
environment into an implementation failure.  They emit a machine-readable
BLOCKED result and exit with status 2 when formal credentials are absent.
"""
from __future__ import annotations

import json
import os
import sys


def require_acceptance_credentials(*names: str) -> None:
    missing = [name for name in names if not os.environ.get(name)]
    if not missing:
        return
    print(json.dumps({
        "result": "BLOCKED",
        "reason": "MISSING_ACCEPTANCE_CREDENTIALS",
        "missing": missing,
        "message": "需要合法的正式 A/B 登录凭据；脚本不会猜测或重置密码。",
    }, ensure_ascii=False, indent=2))
    raise SystemExit(2)
