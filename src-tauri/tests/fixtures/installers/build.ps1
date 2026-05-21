# Build tiny test MSIs for the Agent 07 installer integration tests.
#
# Produces three artifacts in the same directory as this script:
#   IPTVHubTestApp_v1.0.0.msi  — registers DisplayVersion=1.0.0
#   IPTVHubTestApp_v2.0.0.msi  — registers DisplayVersion=2.0.0
#   IPTVHubTestApp_broken.msi  — same WiX source as v1 but with the embedded cab
#                                truncated, so msiexec returns a non-zero exit.
#
# Exit codes:
#   0  — all three MSIs built successfully
#   78 — WiX Toolset not on PATH (the conventional CMake "skip" exit); the
#        integration test reads this and skips every test in the file.
#   1  — any other build failure
#
# Detect WiX v4/v5 (`wix.exe`) first; fall back to WiX v3 (`candle.exe` + `light.exe`).
# The integration test only requires the resulting .msi files; both toolsets produce
# functionally-equivalent output for our tiny package.

[CmdletBinding()]
param(
    [string] $OutDir
)

$ErrorActionPreference = 'Stop'

# `$PSScriptRoot` is only populated when the script is invoked from disk; default it
# manually so `-File ... build.ps1` (with no $PSScriptRoot pre-set) still works.
if ([string]::IsNullOrEmpty($OutDir)) {
    if (-not [string]::IsNullOrEmpty($PSScriptRoot)) {
        $OutDir = $PSScriptRoot
    }
    else {
        $OutDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    }
}

function Write-Skip {
    Write-Host "WiX not detected -- install via 'winget install WixToolset.Wix' to enable installer integration tests." -ForegroundColor Yellow
    exit 78
}

$wix = Get-Command 'wix.exe' -ErrorAction SilentlyContinue
$candle = Get-Command 'candle.exe' -ErrorAction SilentlyContinue
$light = Get-Command 'light.exe' -ErrorAction SilentlyContinue

if (-not $wix -and -not ($candle -and $light)) {
    Write-Skip
}

# WiX v4/v5 (`wix.exe`) is a dotnet tool and requires the .NET runtime to actually
# execute. Probe it once; if the runtime is missing the tool exits non-zero with a
# clear "must install .NET" line. Treat that case as "not effectively usable" and
# skip cleanly so CI on hosts without .NET doesn't hard-fail.
if ($wix) {
    $probe = ''
    try {
        $prev = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        $probe = (& $wix.Source --version 2>&1) -join "`n"
        $probeExit = $LASTEXITCODE
        $ErrorActionPreference = $prev
    }
    catch {
        $probe = $_.Exception.Message
        $probeExit = 1
        $ErrorActionPreference = $prev
    }
    if ($probeExit -ne 0 -or $probe -match 'You must install \.NET') {
        Write-Host "WiX wix.exe present but unusable: $probe" -ForegroundColor Yellow
        if (-not ($candle -and $light)) {
            Write-Skip
        }
        # Fall through to WiX v3 if available.
        $wix = $null
    }
}

$existingV1 = Join-Path $OutDir 'IPTVHubTestApp_v1.0.0.msi'
$existingV2 = Join-Path $OutDir 'IPTVHubTestApp_v2.0.0.msi'
$existingBroken = Join-Path $OutDir 'IPTVHubTestApp_broken.msi'
if ((Test-Path $existingV1) -and (Test-Path $existingV2) -and (Test-Path $existingBroken)) {
    Write-Host "Fixture MSIs already present in $OutDir; reusing." -ForegroundColor Green
    exit 0
}

# Stable upgrade code so both MSIs target the same product (so v2 upgrades v1 cleanly).
$upgradeCode = 'A4D1F7B6-3D6C-4A19-B8F3-5B6E3A41B7C2'
# Per-product GUIDs differ across versions because Windows Installer requires a fresh
# product code on each major version of an MSI.
$productCodeV1 = '1FB3E9C0-2D8C-4A2B-9F4A-7E6B1C5D8A91'
$productCodeV2 = '2C4D8E10-AB3F-4F7C-8B1D-6F2A9C3B5D02'

$workDir = Join-Path $OutDir '.build'
if (Test-Path $workDir) { Remove-Item $workDir -Recurse -Force }
New-Item -ItemType Directory -Path $workDir -Force | Out-Null

# A tiny payload file. The installer just drops this under the install dir.
$payloadFile = Join-Path $workDir 'iptv-hub-test-payload.txt'
Set-Content -Path $payloadFile -Value 'IPTV Hub test app payload' -NoNewline

function Build-Msi {
    param(
        [string] $Version,
        [string] $ProductCode,
        [string] $OutPath
    )

    $wxs = @"
<?xml version="1.0" encoding="UTF-8"?>
<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs">
  <Package Name="IPTVHubTestApp"
           Manufacturer="IPTV Hub Test Suite"
           Version="$Version"
           UpgradeCode="$upgradeCode"
           ProductCode="$ProductCode"
           Scope="perUser"
           Language="1033">
    <MajorUpgrade DowngradeErrorMessage="A newer version is already installed." />
    <MediaTemplate EmbedCab="yes" />
    <StandardDirectory Id="LocalAppDataFolder">
      <Directory Id="INSTALLFOLDER" Name="IPTVHubTestApp">
        <Component Id="MainComponent" Guid="*">
          <File Id="PayloadFile" Source="$payloadFile" KeyPath="yes" />
        </Component>
      </Directory>
    </StandardDirectory>
    <Feature Id="Main" Title="Main" Level="1">
      <ComponentRef Id="MainComponent" />
    </Feature>
  </Package>
</Wix>
"@
    $wxsPath = Join-Path $workDir ("p$Version.wxs" -replace '\.', '_')
    Set-Content -Path $wxsPath -Value $wxs

    if ($wix) {
        & $wix.Source build -arch x64 -o $OutPath $wxsPath 2>&1 | Write-Host
        if ($LASTEXITCODE -ne 0) { throw "wix build failed for v$Version (exit $LASTEXITCODE)" }
    }
    else {
        # WiX v3 fallback. v3 uses an older schema; rewrite on the fly.
        $wxs3 = @"
<?xml version="1.0" encoding="UTF-8"?>
<Wix xmlns="http://schemas.microsoft.com/wix/2006/wi">
  <Product Id="$ProductCode" Name="IPTVHubTestApp" Language="1033" Version="$Version"
           Manufacturer="IPTV Hub Test Suite" UpgradeCode="$upgradeCode">
    <Package Description="IPTV Hub test fixture" InstallerVersion="500" Compressed="yes" InstallScope="perUser" />
    <MajorUpgrade DowngradeErrorMessage="A newer version is already installed." />
    <MediaTemplate EmbedCab="yes" />
    <Directory Id="TARGETDIR" Name="SourceDir">
      <Directory Id="LocalAppDataFolder">
        <Directory Id="INSTALLFOLDER" Name="IPTVHubTestApp" />
      </Directory>
    </Directory>
    <DirectoryRef Id="INSTALLFOLDER">
      <Component Id="MainComponent" Guid="*">
        <File Id="PayloadFile" Source="$payloadFile" KeyPath="yes" />
      </Component>
    </DirectoryRef>
    <Feature Id="Main" Title="Main" Level="1">
      <ComponentRef Id="MainComponent" />
    </Feature>
  </Product>
</Wix>
"@
        Set-Content -Path $wxsPath -Value $wxs3
        $wixobj = [System.IO.Path]::ChangeExtension($wxsPath, '.wixobj')
        & $candle.Source -arch x64 -out $wixobj $wxsPath 2>&1 | Write-Host
        if ($LASTEXITCODE -ne 0) { throw "candle failed for v$Version (exit $LASTEXITCODE)" }
        & $light.Source -out $OutPath $wixobj 2>&1 | Write-Host
        if ($LASTEXITCODE -ne 0) { throw "light failed for v$Version (exit $LASTEXITCODE)" }
    }

    if (-not (Test-Path $OutPath)) { throw "expected MSI at $OutPath was not produced" }
}

Build-Msi -Version '1.0.0' -ProductCode "{$productCodeV1}" -OutPath $existingV1
Build-Msi -Version '2.0.0' -ProductCode "{$productCodeV2}" -OutPath $existingV2

# Truncate the v1 MSI to make a "broken" copy. msiexec rejects truncated installers
# with a non-zero exit (typically 1602/1603), exercising the rollback path.
Copy-Item $existingV1 $existingBroken -Force
$brokenStream = [System.IO.File]::Open($existingBroken, 'Open', 'Write')
try {
    $brokenStream.SetLength([Math]::Floor($brokenStream.Length / 2))
}
finally {
    $brokenStream.Dispose()
}

Remove-Item $workDir -Recurse -Force

Write-Host "Built fixture MSIs in $OutDir" -ForegroundColor Green
exit 0
