#requires -Version 5.1
<#
.SYNOPSIS
  Produces a release MSI under src-tauri/target/release/bundle/.
#>
$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot\..
try {
  # One-time install of cargo-tauri-cli on a fresh machine. Idempotent — the
  # `cargo tauri --version` probe short-circuits when the binary is already on
  # PATH. Pinned to ^2.0 to track the Tauri 2 ABI declared in Cargo.toml.
  & cargo tauri --version *> $null
  if ($LASTEXITCODE -ne 0) {
    Write-Host 'installing cargo-tauri-cli (one-time)…' -ForegroundColor Cyan
    cargo install tauri-cli --locked --version '^2.0'
    if ($LASTEXITCODE -ne 0) { throw 'cargo install tauri-cli failed' }
  }

  Write-Host 'Building release MSI…' -ForegroundColor Cyan
  Push-Location frontend
  try { npm ci; npm run build } finally { Pop-Location }
  cargo tauri build --target x86_64-pc-windows-msvc
  Write-Host 'Done. Artifacts under src-tauri\target\release\bundle\' -ForegroundColor Green
} finally { Pop-Location }
