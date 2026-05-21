#requires -Version 5.1
<#
.SYNOPSIS
    IPTV Hub — operator-side deploy entrypoint (PowerShell sibling of deploy.sh).

.DESCRIPTION
    Thin wrapper around scripts/deploy.py (Paramiko). The Python script does the
    real work: regenerates artifacts, SCPs them, runs nginx -t + reload, brings
    the compose stack up, verifies. Credentials live in
    $env:IPTV_HUB_VPS_ENV_PATH (default G:\private\.env.deploy) and are never
    echoed by this script or the Python child.
#>
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot\..
try {
    $pythonBin = $env:IPTV_HUB_PYTHON
    if (-not $pythonBin) {
        $candidates = @(
            'C:\Python313\python.exe',
            'C:\Python312\python.exe',
            'C:\Python311\python.exe'
        )
        foreach ($p in $candidates) {
            if (Test-Path $p) { $pythonBin = $p; break }
        }
        if (-not $pythonBin) {
            $cmd = Get-Command python -ErrorAction SilentlyContinue
            if ($cmd) { $pythonBin = $cmd.Source }
        }
    }
    if (-not $pythonBin -or -not (Test-Path $pythonBin)) {
        Write-Error "deploy: no Python 3 interpreter found. Install Python 3.11+ or set `$env:IPTV_HUB_PYTHON."
        exit 2
    }

    & $pythonBin -c "import paramiko" 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Error "deploy: paramiko not installed for $pythonBin. Install with: `"$pythonBin`" -m pip install paramiko"
        exit 2
    }

    & $pythonBin scripts\deploy.py
    exit $LASTEXITCODE
} finally { Pop-Location }
