#requires -Version 5.1
<#
.SYNOPSIS
    IPTV Hub — local Windows preflight (mirror of deploy/scripts/preflight.sh).

.DESCRIPTION
    Reads deploy/ports.json and verifies every port the stack will bind is currently
    free on this Windows machine (useful for local docker-compose dev). The real
    deploy preflight runs on the VPS via the .sh sibling.

.OUTPUTS
    Exit 0 = clean. 1 = at least one port already in use. 2 = script error.
#>

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$portsJsonPath = Join-Path $repoRoot 'deploy\ports.json'

if (-not (Test-Path $portsJsonPath)) {
    Write-Error "preflight: missing $portsJsonPath"
    exit 2
}

$ports = Get-Content -LiteralPath $portsJsonPath -Raw | ConvertFrom-Json

$wanted = [System.Collections.Generic.List[int]]::new()
$wanted.Add($ports.reverse_proxy.http)
$wanted.Add($ports.reverse_proxy.https)
$wanted.Add($ports.reverse_proxy.admin_api)
foreach ($name in $ports.infra.PSObject.Properties.Name) { $wanted.Add($ports.infra.$name) }
foreach ($app in $ports.apps) {
    if ($app.PSObject.Properties.Name -contains 'web_deployable' -and $app.web_deployable -eq $false) { continue }
    $wanted.Add($app.http); $wanted.Add($app.ws); $wanted.Add($app.metrics)
}
$wanted = $wanted | Sort-Object -Unique

$listening = @{}
foreach ($conn in (Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue)) {
    $listening[$conn.LocalPort] = $true
}

$failures = 0
foreach ($p in $wanted) {
    if ($listening.ContainsKey([int]$p)) {
        $owner = (Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue |
                  Select-Object -First 1 -ExpandProperty OwningProcess)
        $procName = if ($owner) { (Get-Process -Id $owner -ErrorAction SilentlyContinue).ProcessName } else { 'unknown' }
        Write-Host ("preflight: PORT {0} IS IN USE by {1} (pid {2})" -f $p, $procName, $owner) -ForegroundColor Red
        $failures++
    }
}

if ($failures -gt 0) {
    Write-Host ("preflight: {0} port(s) in use" -f $failures) -ForegroundColor Red
    exit 1
}

Write-Host ("preflight: {0} ports clean." -f $wanted.Count) -ForegroundColor Green
exit 0
