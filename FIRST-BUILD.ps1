# TrayBin 2.1.5 Preview - first build from a fresh full-source archive.
# Intended for Windows 11 x64, PowerShell 5.1+, Node.js and the Rust MSVC toolchain.
$ErrorActionPreference = 'Stop'
Push-Location -LiteralPath $PSScriptRoot
try {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Install Node.js LTS first.' }
    if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { throw 'npm.cmd is not available.' }
    if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) { throw 'Install Rust MSVC and Windows C++ Build Tools first.' }
    $exe = Join-Path $PSScriptRoot 'node_modules\.bin\tauri.cmd'
    if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
        Write-Host '[1/3] Fresh project: installing locked npm dependencies...' -ForegroundColor Cyan
        & npm.cmd ci
        if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
    } else {
        Write-Host '[1/3] Existing npm dependencies found: keeping them.' -ForegroundColor Green
    }
    Write-Host '[2/3] Ensuring locked Windows Rust dependencies are available...' -ForegroundColor Cyan
    Push-Location -LiteralPath (Join-Path $PSScriptRoot 'src-tauri')
    try {
        & cargo fetch --locked --target x86_64-pc-windows-msvc
        if ($LASTEXITCODE -ne 0) { throw 'cargo fetch failed; check Rust installation/network.' }
    } finally { Pop-Location }
    Write-Host '[3/3] Running project tests and Windows Release build...' -ForegroundColor Cyan
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'BUILD-RELEASE.ps1')
    if ($LASTEXITCODE -ne 0) { throw 'Windows release build failed.' }
    Write-Host 'TrayBin v2.1.5 Preview build complete.' -ForegroundColor Green
    exit 0
} catch {
    Write-Host ('FIRST BUILD FAILED: ' + $_.Exception.Message) -ForegroundColor Red
    exit 1
} finally { Pop-Location }
