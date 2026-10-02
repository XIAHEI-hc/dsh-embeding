$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
python -m venv .venv
if ($LASTEXITCODE -ne 0) { throw "venv failed" }
$Wheel = (Get-ChildItem vendor/official-sdk/*.whl | Select-Object -First 1).FullName
& .venv/Scripts/python.exe -m pip install -c constraints.txt --pre $Wheel ".[dev]"
if ($LASTEXITCODE -ne 0) { throw "installation failed" }
npm ci --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw "official Web installation failed" }
Write-Host "复制 .env.example 为 .env，配置后运行 .venv/Scripts/python.exe -m workbench.cli web"
