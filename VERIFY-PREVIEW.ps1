# Compatibility entry point. Preview checks live in VERIFY-RELEASE.ps1.
$ErrorActionPreference = 'Stop'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'VERIFY-RELEASE.ps1')
exit $LASTEXITCODE
