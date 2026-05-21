#requires -Version 5.1
<#
.SYNOPSIS
  Verifies the local environment can build and run IPTV Hub.

.DESCRIPTION
  Checks Rust toolchain, Node.js, system libraries needed by tauri-build, and the
  presence of the expected folders. Prints PASS/FAIL per check and exits non-zero
  if any required check failed.
#>

$ErrorActionPreference = 'Stop'
$global:Failures = 0

function Test-Check {
  param(
    [Parameter(Mandatory)] [string] $Name,
    [Parameter(Mandatory)] [scriptblock] $Probe,
    [string] $Fix = ''
  )
  Write-Host -NoNewline ("  {0,-32} " -f $Name)
  try {
    & $Probe | Out-Null
    Write-Host 'PASS' -ForegroundColor Green
  } catch {
    Write-Host 'FAIL' -ForegroundColor Red
    if ($Fix) { Write-Host "    fix: $Fix" -ForegroundColor Yellow }
    $global:Failures++
  }
}

Write-Host 'IPTV Hub — doctor'
Write-Host ''

Test-Check 'rustc available' {
  $v = rustc --version
  if (-not $v) { throw 'rustc not found' }
} 'install Rust from https://rustup.rs and re-run'

Test-Check 'cargo available' {
  $v = cargo --version
  if (-not $v) { throw 'cargo not found' }
} 'install Rust from https://rustup.rs and re-run'

Test-Check 'rust 1.82+ (workspace pin)' {
  $line = rustc --version
  if ($line -notmatch 'rustc (\d+)\.(\d+)') { throw 'cannot parse rustc version' }
  $major = [int]$Matches[1]
  $minor = [int]$Matches[2]
  if ($major -lt 1 -or ($major -eq 1 -and $minor -lt 82)) { throw "got $line" }
} 'rustup update stable'

Test-Check 'node 20+ available' {
  $v = node --version
  if ($v -notmatch 'v(\d+)') { throw "node not found ($v)" }
  if ([int]$Matches[1] -lt 20) { throw "got $v, need v20+" }
} 'install Node.js 20+ from https://nodejs.org'

Test-Check 'npm available' {
  $null = npm --version
} 'install Node.js 20+ from https://nodejs.org'

Test-Check 'webview2 runtime' {
  $found = Get-ItemProperty -Path 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}' -ErrorAction SilentlyContinue
  if (-not $found) {
    $found = Get-ItemProperty -Path 'HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}' -ErrorAction SilentlyContinue
  }
  if (-not $found) { throw 'WebView2 runtime not installed' }
} 'download "Evergreen Bootstrapper" from https://developer.microsoft.com/microsoft-edge/webview2/'

Test-Check 'C:\IPTV exists' {
  if (-not (Test-Path 'C:\IPTV')) { throw 'C:\IPTV not found' }
} 'create C:\IPTV and place app folders/installers there'

Test-Check 'cargo workspace parses' {
  Push-Location $PSScriptRoot\..
  try {
    cargo metadata --format-version=1 --offline 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'cargo metadata failed' }
  } finally { Pop-Location }
} 'check Cargo.toml and src-tauri/Cargo.toml syntax'

Write-Host ''
if ($global:Failures -gt 0) {
  Write-Host "$global:Failures check(s) failed." -ForegroundColor Red
  exit 1
} else {
  Write-Host 'All checks passed.' -ForegroundColor Green
  exit 0
}
