# TrayBin v2.0.0 Stable - Windows release verification for PowerShell 5.1+.
# Source integrity, JavaScript tests, JSON/version validation and Windows Rust tests.
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
function Invoke-Checked([string]$Exe, [string[]]$Arguments) {
    & $Exe @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Exe failed (exit code $LASTEXITCODE)" }
}
function Get-Sha([string]$Path) {
    (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}
try {
    Write-Host '[1/5] Checking canonical source SHA-256...' -ForegroundColor Cyan
    $n = 0
    foreach ($line in [IO.File]::ReadAllLines((Join-Path $PSScriptRoot 'FILE_MANIFEST_SHA256.txt'), [Text.Encoding]::UTF8)) {
        if ($line -notmatch '^([0-9a-f]{64})  (.+)$') { throw "Invalid manifest line: $line" }
        $expect = $Matches[1]; $relative = $Matches[2]
        if ($relative -match '(^|/)\.\.(?:/|$)' -or [IO.Path]::IsPathRooted($relative)) { throw "Unsafe manifest path: $relative" }
        $target = Join-Path $PSScriptRoot ($relative.Replace('/', '\'))
        if (-not (Test-Path -LiteralPath $target -PathType Leaf)) { throw "Missing source file: $relative" }
        if ((Get-Sha $target) -ne $expect) { throw "Source SHA mismatch: $relative" }
        $n++
    }
    Write-Host "Source files verified: $n" -ForegroundColor Green

    Write-Host '[2/5] Checking JS and 22 regression tests...' -ForegroundColor Cyan
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js is required' }
    Invoke-Checked 'node' @('--check', '.\ui\app.js')
    Invoke-Checked 'node' @('--test', '.\tests\panel.test.cjs', '.\tests\source-contract.test.cjs')

    Write-Host '[3/5] Checking versions and JSON...' -ForegroundColor Cyan
    $npm = Get-Content '.\package.json' -Raw -Encoding UTF8 | ConvertFrom-Json
    $tauri = Get-Content '.\src-tauri\tauri.conf.json' -Raw -Encoding UTF8 | ConvertFrom-Json
    $null = Get-Content '.\src-tauri\capabilities\default.json' -Raw -Encoding UTF8 | ConvertFrom-Json
    $cargo = Get-Content '.\src-tauri\Cargo.toml' -Raw -Encoding UTF8
    if ($npm.version -ne '2.0.0' -or $tauri.version -ne $npm.version -or $cargo -notmatch '(?m)^version\s*=\s*"2\.0\.0"') {
        throw 'Inconsistent Stable versions in npm/Tauri/Cargo'
    }
    if ($tauri.app.windows[0].decorations -ne $false -or $tauri.app.windows[0].shadow -ne $false) {
        throw 'Approved borderless window configuration changed'
    }
    Write-Host '[4/5] Checking Windows Rust source...' -ForegroundColor Cyan
    if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) { throw 'Cargo/Rust MSVC is required' }
    Push-Location '.\src-tauri'
    try {
        Invoke-Checked 'cargo' @('check', '--target', 'x86_64-pc-windows-msvc')
        Write-Host '[5/5] Running Windows Rust unit tests...' -ForegroundColor Cyan
        Invoke-Checked 'cargo' @('test', '--target', 'x86_64-pc-windows-msvc')
    } finally { Pop-Location }
    Write-Host 'TRAYBIN STABLE SOURCE AND TESTS VERIFIED.' -ForegroundColor Green
    exit 0
} catch {
    Write-Host ('RELEASE VERIFICATION FAILED: ' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
