#requires -Version 5.1
<#
.SYNOPSIS
    Installs git hooks via lefthook (CONTRACT §9, AGENT_PLAN Agent 21).

.DESCRIPTION
    Mirrors scripts/install-pre-commit.sh. Picks the locally-available lefthook in
    this order:
      1. `lefthook` on PATH
      2. `npx --no-install lefthook` if a previous `npm install` resolved it
      3. `npx --yes lefthook@latest` as a last-resort one-shot fetch
#>
$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot\..
try {
    if (-not (Test-Path '.git')) {
        Write-Error "install-pre-commit: no .git directory — run from inside a git checkout"
        exit 1
    }
    if (-not (Test-Path 'lefthook.yml')) {
        Write-Error "install-pre-commit: lefthook.yml missing at repo root"
        exit 1
    }

    $lefthook = Get-Command lefthook -ErrorAction SilentlyContinue
    if ($lefthook) {
        & $lefthook.Path install
    } else {
        $npx = Get-Command npx.cmd -ErrorAction SilentlyContinue
        if (-not $npx) { $npx = Get-Command npx -ErrorAction SilentlyContinue }
        if (-not $npx) {
            Write-Error "install-pre-commit: neither lefthook nor npx is on PATH. Install lefthook: https://github.com/evilmartians/lefthook"
            exit 1
        }
        try {
            & $npx.Path --no-install lefthook install 2>$null
            if ($LASTEXITCODE -ne 0) { throw "no local lefthook" }
        } catch {
            & $npx.Path --yes lefthook@latest install
            if ($LASTEXITCODE -ne 0) { throw "lefthook install failed" }
        }
    }

    Write-Host "install-pre-commit: lefthook hooks installed (pre-commit, pre-push)." -ForegroundColor Green
} finally { Pop-Location }
