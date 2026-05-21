#requires -Version 5.1
<#
.SYNOPSIS
  Produces a release MSI under src-tauri/target/release/bundle/.
#>
$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot\..
try {
  Write-Host 'Building release MSI…' -ForegroundColor Cyan
  Push-Location frontend
  try { npm ci; npm run build } finally { Pop-Location }
  cargo tauri build --target x86_64-pc-windows-msvc
  Write-Host 'Done. Artifacts under src-tauri\target\release\bundle\' -ForegroundColor Green
} finally { Pop-Location }
