# Compatibility entry point. Stable packaging lives in BUILD-RELEASE.ps1.
$ErrorActionPreference = 'Stop'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'BUILD-RELEASE.ps1')
exit $LASTEXITCODE
