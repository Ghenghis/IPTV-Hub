#requires -Version 5.1
<#
.SYNOPSIS
  Launches IPTV Hub in development mode (Tauri dev + Vite dev server).
#>
$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot\..
try {
  Write-Host 'IPTV Hub — dev mode' -ForegroundColor Cyan
  if (-not (Test-Path 'frontend/node_modules')) {
    Write-Host 'installing frontend deps…' -ForegroundColor Yellow
    Push-Location frontend
    try { npm ci } finally { Pop-Location }
  }
  cargo tauri dev
} finally { Pop-Location }
