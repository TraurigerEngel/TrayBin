# TrayBin v2.1.4 Tray-Only - optimized portable Windows x64 archive.
# Produces portable EXE/ZIP and complete reproducible Source.zip with lockfiles.
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
try {
    if (@(Get-Process -Name 'traybin' -ErrorAction SilentlyContinue).Count -gt 0) {
        throw 'Close every TrayBin process using Exit from TrayBin before building.'
    }
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'VERIFY-RELEASE.ps1')
    if ($LASTEXITCODE -ne 0) { throw 'Release verification failed' }
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw 'npm is not available' }
    if (-not (Test-Path -LiteralPath '.\node_modules\.bin\tauri.cmd' -PathType Leaf)) {
        throw 'Existing node_modules missing: restore your previous project dependencies'
    }
    & npm run build:release
    if ($LASTEXITCODE -ne 0) { throw "Optimized Tauri build failed: $LASTEXITCODE" }

    $built = Join-Path $PSScriptRoot 'src-tauri\target\release\traybin.exe'
    if (-not (Test-Path -LiteralPath $built -PathType Leaf)) { throw "Release EXE missing: $built" }
    $out = Join-Path $PSScriptRoot 'Artifacts\TrayBin_v2.1.4_Tray_Only'
    $portable = Join-Path $out 'Portable'
    New-Item -ItemType Directory -Path $portable -Force | Out-Null
    $exe = Join-Path $portable 'TrayBin.exe'
    Copy-Item -LiteralPath $built -Destination $exe -Force
    $readme = Join-Path $portable 'README_PORTABLE_RU.txt'
    @'
TrayBin v2.1.4 Tray-Only - Portable
Windows x64 / Windows 11. Tray-only application: no application windows are created.
No installer and no administrator rights are needed for the portable build.
Keep TrayBin.exe in a permanent folder before enabling autostart (stores absolute EXE path).
Close the existing TrayBin process before launching this preview.
One left click: open Recycle Bin. Double-click: Windows confirmation before emptying.
Right click: native menu with only Open Recycle Bin, Empty Recycle Bin, Exit.
Unsigned executable: Windows reputation prompts can appear; verify source and SHA-256.
The working Windows Shell backend and five classic tray icons are preserved.
'@ | Set-Content -LiteralPath $readme -Encoding UTF8
    $sums = Join-Path $portable 'SHA256SUMS.txt'
    $eHash = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant()
    $rHash = (Get-FileHash -LiteralPath $readme -Algorithm SHA256).Hash.ToLowerInvariant()
    @("$eHash  TrayBin.exe", "$rHash  README_PORTABLE_RU.txt") | Set-Content -LiteralPath $sums -Encoding ASCII
    $zip = Join-Path $out 'TrayBin_v2.1.4_Tray_Only_Portable.zip'
    if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
    Compress-Archive -LiteralPath @($exe, $readme, $sums) -DestinationPath $zip -CompressionLevel Optimal
    if (-not (Test-Path -LiteralPath $zip -PathType Leaf)) { throw 'Portable ZIP was not created' }
    $zipHash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
    # Package exact, verified Stable sources (including npm and Cargo lockfiles).
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'CREATE-SOURCE-ARCHIVE.ps1')
    if ($LASTEXITCODE -ne 0) { throw 'Preview source archive packaging failed' }
    $sourceZip = Join-Path $out 'TrayBin_v2.1.4_Tray_Only_Source.zip'
    if (-not (Test-Path -LiteralPath $sourceZip -PathType Leaf)) { throw 'Preview source archive missing' }
    $sourceHash = (Get-FileHash -LiteralPath $sourceZip -Algorithm SHA256).Hash.ToLowerInvariant()
    $artifacts = Join-Path $out 'RELEASE_ARTIFACTS_SHA256.txt'
    @("$eHash  Portable/TrayBin.exe", "$zipHash  TrayBin_v2.1.4_Tray_Only_Portable.zip", "$sourceHash  TrayBin_v2.1.4_Tray_Only_Source.zip") |
        Set-Content -LiteralPath $artifacts -Encoding ASCII
    Write-Host "Preview portable: $zip" -ForegroundColor Green
    Write-Host "EXE SHA256: $eHash"
    Write-Host "ZIP SHA256: $zipHash"
    Write-Host "Source ZIP SHA256: $sourceHash"
    Write-Host 'TrayBin v2.1.4 Tray-Only portable and source artifacts created.' -ForegroundColor Green
    exit 0
} catch {
    Write-Host ('RELEASE BUILD FAILED: ' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
