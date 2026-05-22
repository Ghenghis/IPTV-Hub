#requires -Version 5.1
<#
.SYNOPSIS
  Fast pre-commit gate: forbid-stubs, fmt check, prettier check, eslint.

.DESCRIPTION
  Mirrors scripts/pre-commit.sh. Heavier checks (compile, clippy, test) run on
  pre-push and in CI. Designed to finish in under 10 seconds on a typical change.
#>
$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot\..
try {
    Write-Host '== forbid-stubs ==' -ForegroundColor Cyan
    & "$PSScriptRoot\forbid-stubs.ps1"
    if ($LASTEXITCODE -ne 0) { throw "forbid-stubs failed" }

    Write-Host '== rust: fmt check ==' -ForegroundColor Cyan
    cargo fmt --all -- --check
    if ($LASTEXITCODE -ne 0) { throw "cargo fmt --check failed" }

    if (Test-Path 'frontend/node_modules') {
        Write-Host '== frontend: prettier check ==' -ForegroundColor Cyan
        Push-Location 'frontend'
        try {
            npm run format:check
            if ($LASTEXITCODE -ne 0) { throw "prettier check failed" }
            Write-Host '== frontend: eslint ==' -ForegroundColor Cyan
            npm run lint
            if ($LASTEXITCODE -ne 0) { throw "eslint failed" }
        } finally { Pop-Location }
    } else {
        Write-Host 'frontend/node_modules not present; skipping prettier/eslint (run npm install once).' -ForegroundColor Yellow
    }

    Write-Host ''
    Write-Host 'pre-commit: clean.' -ForegroundColor Green
} finally { Pop-Location }
