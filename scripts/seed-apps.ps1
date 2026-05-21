#requires -Version 5.1
<#
.SYNOPSIS
    scripts/seed-apps.ps1 — heuristic seeder for `apps.json` (PowerShell sibling of seed-apps.sh).

.PARAMETER Path
    Directory to scan. Each immediate sub-directory is classified per the rules
    in src-tauri/src/seed.rs and emitted as a proposed AppEntry.

.PARAMETER Release
    If set, builds the iptv-hub-seed CLI with `--release` (slower first run,
    faster subsequent runs and cleaner output for production manifests).

.OUTPUTS
    Proposed manifest printed to stdout as JSON. Pipe to a file for review:

        scripts\seed-apps.ps1 -Path C:\IPTV > apps-proposal.json
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Path,

    [switch]$Release
)

$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot\..
try {
    $cargoArgs = @('run', '--quiet', '--bin', 'iptv-hub-seed')
    if ($Release) {
        $cargoArgs = @('run', '--release', '--quiet', '--bin', 'iptv-hub-seed')
    }
    $cargoArgs += @('--', $Path)
    & cargo @cargoArgs
    exit $LASTEXITCODE
} finally { Pop-Location }
