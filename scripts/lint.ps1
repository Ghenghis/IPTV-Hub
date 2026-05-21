#requires -Version 5.1
$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot\..
try {
  Write-Host 'cargo clippy -D warnings…' -ForegroundColor Cyan
  cargo clippy --workspace --all-targets --locked -- -D warnings
  Write-Host 'eslint…' -ForegroundColor Cyan
  Push-Location frontend
  try { npm run lint } finally { Pop-Location }
  Write-Host 'forbid-stubs…' -ForegroundColor Cyan
  bash scripts/forbid-stubs.sh
  Write-Host 'Done.' -ForegroundColor Green
} finally { Pop-Location }
