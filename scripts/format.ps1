#requires -Version 5.1
$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot\..
try {
  Write-Host 'cargo fmt…' -ForegroundColor Cyan
  cargo fmt --all
  Write-Host 'prettier…' -ForegroundColor Cyan
  Push-Location frontend
  try { npm run format } finally { Pop-Location }
  Write-Host 'Done.' -ForegroundColor Green
} finally { Pop-Location }
