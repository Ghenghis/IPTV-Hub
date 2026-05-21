#requires -Version 5.1
<#
.SYNOPSIS
  Runs the full IPTV Hub test gate locally — mirror of .github/workflows/ci.yml.
#>
$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot\..
try {
  Write-Host '== forbid-stubs ==' -ForegroundColor Cyan
  bash scripts/forbid-stubs.sh

  Write-Host '== rust: fmt check ==' -ForegroundColor Cyan
  cargo fmt --all -- --check

  Write-Host '== rust: clippy (warnings as errors) ==' -ForegroundColor Cyan
  cargo clippy --workspace --all-targets --locked -- -D warnings

  Write-Host '== rust: build ==' -ForegroundColor Cyan
  cargo build --workspace --locked

  Write-Host '== rust: test ==' -ForegroundColor Cyan
  cargo test --workspace --locked

  Write-Host '== frontend: install ==' -ForegroundColor Cyan
  Push-Location frontend
  try {
    npm ci
    Write-Host '== frontend: tsc ==' -ForegroundColor Cyan
    npm run build
    Write-Host '== frontend: prettier ==' -ForegroundColor Cyan
    npm run format:check
  } finally { Pop-Location }

  Write-Host ''
  Write-Host 'All gates passed.' -ForegroundColor Green
} finally { Pop-Location }
