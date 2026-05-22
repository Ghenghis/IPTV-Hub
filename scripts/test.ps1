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

    Write-Host '== frontend: e2e (playwright) ==' -ForegroundColor Cyan
    # CI installs Playwright + browsers; locally the gate is skipped with a
    # clear hint when the browser cache is missing.
    $hasPlaywrightBin = $false
    try {
      $null = & npx --no-install playwright --version 2>$null
      $hasPlaywrightBin = $LASTEXITCODE -eq 0
    } catch { $hasPlaywrightBin = $false }

    if ($hasPlaywrightBin) {
      # Default Windows cache is %LOCALAPPDATA%\ms-playwright; PLAYWRIGHT_BROWSERS_PATH
      # overrides it.
      $browserCache = if ($env:PLAYWRIGHT_BROWSERS_PATH) {
        $env:PLAYWRIGHT_BROWSERS_PATH
      } else {
        Join-Path $env:LOCALAPPDATA 'ms-playwright'
      }
      $hasChromium = $false
      if (Test-Path $browserCache) {
        $hasChromium = @(Get-ChildItem -Path $browserCache -Filter 'chromium-*' `
          -ErrorAction SilentlyContinue).Count -gt 0
      }
      if ($hasChromium) {
        npm run test:e2e
      } else {
        Write-Host "playwright is installed but no chromium browser was found at $browserCache;" -ForegroundColor Yellow
        Write-Host '  cd frontend; npx playwright install chromium' -ForegroundColor Yellow
        Write-Host 'to enable the e2e gate. Skipping.' -ForegroundColor Yellow
      }
    } else {
      Write-Host 'playwright not installed; run `npm install` in frontend then' -ForegroundColor Yellow
      Write-Host '`npx playwright install chromium` to enable the e2e gate. Skipping.' -ForegroundColor Yellow
    }
  } finally { Pop-Location }

  Write-Host ''
  Write-Host 'All gates passed.' -ForegroundColor Green
} finally { Pop-Location }
