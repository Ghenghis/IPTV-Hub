#requires -Version 5.1
<#
.SYNOPSIS
    Cuts a release: verify clean tree, run full test gate, bump version, tag, build MSI.

.PARAMETER Version
    New semver version (e.g. 0.2.0).

.DESCRIPTION
    Mirrors scripts/release.sh. Refuses on a dirty tree or non-master/main branch. Runs
    the full test gate before bumping. Updates Cargo.toml, frontend/package.json, and
    src-tauri/tauri.conf.json. Rotates CHANGELOG.md. Commits and tags. Builds the MSI.

    Does NOT push — the owner runs `git push --follow-tags` after reviewing.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Version
)

$ErrorActionPreference = 'Stop'

if ($Version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$') {
    Write-Error "release: version '$Version' is not semver"
    exit 2
}

Push-Location $PSScriptRoot\..
try {
    # 1. Clean tree.
    $status = git status --porcelain
    if ($status) {
        Write-Error "release: working tree is dirty — commit or stash first`n$status"
        exit 1
    }

    # 2. Correct branch.
    $branch = (git symbolic-ref --short HEAD).Trim()
    if ($branch -ne 'master' -and $branch -ne 'main') {
        Write-Error "release: must run on master or main (you are on '$branch')"
        exit 1
    }

    # 3. Full gate.
    Write-Host '== full test gate ==' -ForegroundColor Cyan
    & "$PSScriptRoot\test.ps1"
    if ($LASTEXITCODE -ne 0) { throw "test gate failed" }

    Write-Host "== bumping versions to $Version ==" -ForegroundColor Cyan

    # 4a. Cargo workspace version (only the workspace.package version line).
    $cargoPath = Join-Path $PWD 'Cargo.toml'
    $cargoText = Get-Content -LiteralPath $cargoPath -Raw
    $cargoText = [regex]::Replace(
        $cargoText,
        '(?m)^version\s*=\s*"[^"]+"',
        ('version       = "{0}"' -f $Version),
        [System.Text.RegularExpressions.RegexOptions]::None,
        [timespan]::FromSeconds(2)
    )
    Set-Content -LiteralPath $cargoPath -Value $cargoText -NoNewline

    # 4b. Frontend package.json.
    $pkgPath = Join-Path $PWD 'frontend/package.json'
    $pkg = Get-Content -LiteralPath $pkgPath -Raw | ConvertFrom-Json
    $pkg.version = $Version
    $pkgJson = ($pkg | ConvertTo-Json -Depth 10) + "`n"
    Set-Content -LiteralPath $pkgPath -Value $pkgJson -NoNewline

    # 4c. Tauri conf.
    $tauriPath = Join-Path $PWD 'src-tauri/tauri.conf.json'
    $tauri = Get-Content -LiteralPath $tauriPath -Raw | ConvertFrom-Json
    $tauri.version = $Version
    $tauriJson = ($tauri | ConvertTo-Json -Depth 20) + "`n"
    Set-Content -LiteralPath $tauriPath -Value $tauriJson -NoNewline

    # 5. CHANGELOG rotation.
    $today = (Get-Date -AsUTC).ToString('yyyy-MM-dd')
    $changelogPath = Join-Path $PWD 'CHANGELOG.md'
    $changelog = Get-Content -LiteralPath $changelogPath -Raw
    if ($changelog -notmatch '(?m)^## \[Unreleased\]') {
        throw "CHANGELOG.md has no '## [Unreleased]' header"
    }
    $changelog = [regex]::Replace(
        $changelog,
        '(?m)^## \[Unreleased\]',
        "## [Unreleased]`n`n## [$Version] — $today",
        [System.Text.RegularExpressions.RegexOptions]::None,
        [timespan]::FromSeconds(2),
        1
    )
    Set-Content -LiteralPath $changelogPath -Value $changelog -NoNewline

    # 6. Commit.
    git add Cargo.toml frontend/package.json src-tauri/tauri.conf.json CHANGELOG.md
    git commit -m "release: v$Version"
    if ($LASTEXITCODE -ne 0) { throw "git commit failed" }

    # 7. Tag.
    git tag -a "v$Version" -m "v$Version"
    if ($LASTEXITCODE -ne 0) { throw "git tag failed" }

    # 8. Build MSI.
    Write-Host '== building release MSI ==' -ForegroundColor Cyan
    & "$PSScriptRoot\build.ps1"
    if ($LASTEXITCODE -ne 0) { throw "build.ps1 failed" }

    Write-Host ''
    Write-Host "release: v$Version tagged. push with: git push --follow-tags" -ForegroundColor Green
} finally { Pop-Location }
