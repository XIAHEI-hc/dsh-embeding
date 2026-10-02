#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
python3 -m venv .venv
.venv/bin/python -m pip install -c constraints.txt --pre vendor/official-sdk/*.whl '.[dev]'
npm ci --no-audit --no-fund
printf '\n安装完成。复制 .env.example 为 .env 并配置后运行：\n.venv/bin/python -m workbench.cli web\n'
