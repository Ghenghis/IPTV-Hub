<#
.SYNOPSIS
    IPTV Hub — forbid-stubs tripwire (PowerShell parity for forbid-stubs.sh).

.DESCRIPTION
    Scans runtime source files for stub markers, placeholder data, and empty error
    swallowers. CONTRACT.md §2.1 forbids these patterns; this script is the automated
    enforcement that runs in CI and pre-commit hooks on Windows where bash is not
    guaranteed.

    A line containing the literal annotation `allow-stub: <reason>` is permitted —
    this is the time-bounded allowlist mechanism from CONTRACT.md §2.4.

.OUTPUTS
    Exit code 0 = clean. 1 = forbidden pattern(s) found. 2 = invoked outside repo root.
#>

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

if (-not (Test-Path 'Cargo.toml') -or -not (Test-Path 'src-tauri')) {
    Write-Error "forbid-stubs: must run from repo root (no Cargo.toml or src-tauri/)"
    exit 2
}

# Word-bounded patterns. Each becomes a regex with \b boundaries on both sides so that
# ordinary words like "stubby" or "mockingbird" do not trip the gate.
$wordPatterns = @(
    'TODO', 'FIXME', 'XXX', 'HACK',
    'NOT_IMPLEMENTED', 'NotImplementedException',
    'stub', 'Stub', 'STUB',
    'placeholder', 'Placeholder', 'PLACEHOLDER',
    'mock', 'Mock', 'MOCK'
)

# Literal substrings.
$substringPatterns = @(
    'unimplemented!(',
    'todo!(',
    'not implemented',
    'coming soon',
    'experimental — disabled',
    'experimental -- disabled',
    'will be added later',
    'sample data',
    'fake data',
    'mock data'
)

$sourceRoots = @('src-tauri/src', 'frontend/src', 'scripts')

$excludeDirs = @('node_modules', 'target', 'dist', 'tests', 'fixtures')
$excludeFiles = @('forbid-stubs.sh', 'forbid-stubs.ps1', '*.lock', '*.bak', '*.snap')

function Get-ScanFiles {
    foreach ($root in $sourceRoots) {
        if (-not (Test-Path $root)) { continue }
        Get-ChildItem -LiteralPath $root -Recurse -File -ErrorAction SilentlyContinue |
            Where-Object {
                $isExcludedDir = $false
                foreach ($part in ($_.FullName -split '[\\/]')) {
                    if ($excludeDirs -contains $part) { $isExcludedDir = $true; break }
                }
                if ($isExcludedDir) { return $false }
                foreach ($pat in $excludeFiles) {
                    if ($_.Name -like $pat) { return $false }
                }
                return $true
            }
    }
}

$files = @(Get-ScanFiles)
$failures = 0

function Show-Hits {
    param([string]$Label, [string]$Pattern, [System.Collections.IEnumerable]$Hits)
    if ($Hits) {
        Write-Host "forbid-stubs: $Label '$Pattern' found:" -ForegroundColor Red
        foreach ($hit in $Hits) {
            Write-Host ("  {0}:{1}: {2}" -f $hit.FilePath, $hit.LineNumber, $hit.Line.TrimEnd())
        }
        Write-Host ""
        return $true
    }
    return $false
}

# HTML/JSX attribute use of `placeholder` (e.g. <input placeholder="…">), CSS pseudo
# selectors `::placeholder` and `:placeholder-shown` are web spec terms, not stub
# markers, and are exempt.
$attrExempt = '(placeholder\s*[=:"]|::placeholder|:placeholder-shown)'

foreach ($pattern in $wordPatterns) {
    $regex = "\b" + [regex]::Escape($pattern) + "\b"
    $hits = @()
    foreach ($file in $files) {
        $lineNo = 0
        foreach ($line in (Get-Content -LiteralPath $file.FullName -ErrorAction SilentlyContinue)) {
            $lineNo++
            if ($line -match $regex -and $line -notmatch 'allow-stub:' -and $line -notmatch $attrExempt) {
                $hits += [pscustomobject]@{ FilePath = $file.FullName; LineNumber = $lineNo; Line = $line }
            }
        }
    }
    if (Show-Hits -Label 'word' -Pattern $pattern -Hits $hits) { $failures++ }
}

foreach ($pattern in $substringPatterns) {
    $hits = @()
    foreach ($file in $files) {
        $lineNo = 0
        foreach ($line in (Get-Content -LiteralPath $file.FullName -ErrorAction SilentlyContinue)) {
            $lineNo++
            if ($line.Contains($pattern) -and -not $line.Contains('allow-stub:')) {
                $hits += [pscustomobject]@{ FilePath = $file.FullName; LineNumber = $lineNo; Line = $line }
            }
        }
    }
    if (Show-Hits -Label 'substring' -Pattern $pattern -Hits $hits) { $failures++ }
}

# Empty Rust match arms.
$emptyArmHits = @()
$rustFiles = $files | Where-Object { $_.Extension -eq '.rs' -and $_.FullName -like '*\src-tauri\src\*' }
foreach ($file in $rustFiles) {
    $lineNo = 0
    foreach ($line in (Get-Content -LiteralPath $file.FullName -ErrorAction SilentlyContinue)) {
        $lineNo++
        if ($line -match '^\s*(Err|Ok)\(_\)\s*=>\s*\{\s*\}\s*,?\s*$' -and $line -notmatch 'allow-stub:') {
            $emptyArmHits += [pscustomobject]@{ FilePath = $file.FullName; LineNumber = $lineNo; Line = $line }
        }
    }
}
if ($emptyArmHits) {
    Write-Host "forbid-stubs: empty match arm (silent error swallow):" -ForegroundColor Red
    foreach ($hit in $emptyArmHits) {
        Write-Host ("  {0}:{1}: {2}" -f $hit.FilePath, $hit.LineNumber, $hit.Line.TrimEnd())
    }
    $failures++
}

if ($failures -gt 0) {
    Write-Host ""
    Write-Host "forbid-stubs: $failures forbidden pattern(s) found." -ForegroundColor Red
    Write-Host "fix by replacing the pattern with real code, OR mark the line with"
    Write-Host "  // allow-stub: <reason>   (include issue + expiry date)"
    exit 1
}

Write-Host "forbid-stubs: clean." -ForegroundColor Green
exit 0
