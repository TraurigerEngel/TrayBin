# TrayBin v2.0.0 Stable - complete rebuildable source archive.
# PowerShell 5.1+, no additional modules. Includes generated dependency locks.
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
function Get-Sha([string]$Path) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}
function Assert-Relative([string]$Relative) {
    if ([string]::IsNullOrWhiteSpace($Relative) -or $Relative -match '(^|[/\\])\.\.(?:[/\\]|$)' -or
        $Relative -match '(^|[/\\])\.(?:[/\\]|$)' -or $Relative -match '[:\\]' -or $Relative.StartsWith('/')) {
        throw "Unsafe source path: $Relative"
    }
}
$stageRoot = $null
$checkRoot = $null
try {
    $project = $PSScriptRoot
    $out = Join-Path $project 'Artifacts\TrayBin_v2.0.0_Stable'
    New-Item -Path $out -ItemType Directory -Force | Out-Null
    $zip = Join-Path $out 'TrayBin_v2.0.0_Stable_Source.zip'
    $stamp = [guid]::NewGuid().ToString('N')
    $stageRoot = Join-Path $out ('.source-pack-' + $stamp)
    $sourceName = 'TrayBin_v2.0.0_Stable_Source'
    $stage = Join-Path $stageRoot $sourceName
    $checkRoot = Join-Path $out ('.source-verify-' + $stamp)
    New-Item -Path $stage -ItemType Directory -Force | Out-Null

    $manifestPath = Join-Path $project 'FILE_MANIFEST_SHA256.txt'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'Source manifest is missing' }
    $expected = @{}
    foreach ($line in [IO.File]::ReadAllLines($manifestPath, [Text.Encoding]::UTF8)) {
        if ($line -notmatch '^([0-9a-f]{64})  (.+)$') { throw "Invalid source manifest entry: $line" }
        $sha = $Matches[1]
        $relative = $Matches[2]
        Assert-Relative $relative
        if ($expected.ContainsKey($relative)) { throw "Duplicate source manifest entry: $relative" }
        $expected[$relative] = $sha
    }
    if ($expected.Count -lt 27 -or -not $expected.ContainsKey('CREATE-SOURCE-ARCHIVE.ps1') -or
        -not $expected.ContainsKey('BUILD-RELEASE.ps1')) { throw 'Source manifest is incomplete' }

    # Cargo/npm lock files are generated locally; verify and ship their exact bytes.
    $pkgFile = Join-Path $project 'package.json'
    $pkgLockFile = Join-Path $project 'package-lock.json'
    $cargoLockFile = Join-Path $project 'src-tauri\Cargo.lock'
    if (-not (Test-Path -LiteralPath $pkgLockFile -PathType Leaf)) {
        throw 'package-lock.json is missing; run npm install in the project directory first'
    }
    if (-not (Test-Path -LiteralPath $cargoLockFile -PathType Leaf)) {
        throw 'src-tauri/Cargo.lock is missing; run the Rust release verification/build first'
    }
    $pkg = Get-Content -LiteralPath $pkgFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js is required to validate npm dependency lockfile' }
    if ($pkg.version -ne '2.0.0') { throw 'Stable package version differs from 2.0.0' }
    # Avoid node -e here: Windows PowerShell 5.1 removes nested JavaScript quotation marks.
    # Pass the JS validator path and data as separate command-line arguments.
    $lockValidator = Join-Path $project 'scripts\VERIFY-NPM-LOCK.cjs'
    if (-not (Test-Path -LiteralPath $lockValidator -PathType Leaf)) { throw 'Missing npm lockfile validator' }
    & node $lockValidator $pkgLockFile $pkg.version $pkg.name
    if ($LASTEXITCODE -ne 0) { throw 'package-lock.json validation failed; check npm lockfile before rebuilding' }
    $cargoLockText = Get-Content -LiteralPath $cargoLockFile -Raw -Encoding UTF8
    if ($cargoLockText -notmatch '(?ms)^\[\[package\]\]\s*\r?\nname\s*=\s*"traybin"\s*\r?\nversion\s*=\s*"2\.0\.0"') {
        throw 'Cargo.lock does not match traybin 2.0.0; run the Rust release build'
    }
    $expected['package-lock.json'] = Get-Sha $pkgLockFile
    $expected['src-tauri/Cargo.lock'] = Get-Sha $cargoLockFile
    $expected['FILE_MANIFEST_SHA256.txt'] = Get-Sha $manifestPath

    foreach ($relative in @($expected.Keys | Sort-Object)) {
        Assert-Relative $relative
        $source = Join-Path $project ($relative.Replace('/', '\'))
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Missing source: $relative" }
        $actual = Get-Sha $source
        if ($actual -ne $expected[$relative]) { throw "Source hash mismatch: $relative" }
        $dest = Join-Path $stage ($relative.Replace('/', '\'))
        $parent = Split-Path -Path $dest -Parent
        New-Item -Path $parent -ItemType Directory -Force | Out-Null
        Copy-Item -LiteralPath $source -Destination $dest -ErrorAction Stop
        if ((Get-Sha $dest) -ne $expected[$relative]) { throw "Staged source SHA mismatch: $relative" }
    }
    # A second file listing the hashes of every source file, including dependency locks.
    $archiveManifest = Join-Path $stage 'SOURCE_ARCHIVE_SHA256.txt'
    @($expected.Keys | Sort-Object | ForEach-Object { "$($expected[$_])  $_" }) |
        Set-Content -LiteralPath $archiveManifest -Encoding ASCII

    # Compress the single top-level folder; no build caches or historical patches can enter.
    $tempZip = Join-Path $out ('.source-' + $stamp + '.zip')
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    # ZipFile also includes .gitignore and other dotfiles; Compress-Archive may omit hidden files.
    [IO.Compression.ZipFile]::CreateFromDirectory($stageRoot, $tempZip, [IO.Compression.CompressionLevel]::Optimal, $false)
    if (-not (Test-Path -LiteralPath $tempZip -PathType Leaf)) { throw 'Source archive was not created' }

    # Independently extract and verify every file; reject missing or extra entries.
    New-Item -Path $checkRoot -ItemType Directory -Force | Out-Null
    Expand-Archive -LiteralPath $tempZip -DestinationPath $checkRoot -ErrorAction Stop
    $extracted = Join-Path $checkRoot $sourceName
    if (-not (Test-Path -LiteralPath $extracted -PathType Container)) { throw 'Source archive root folder missing' }
    $expectedPaths = @{}
    foreach ($relative in @($expected.Keys)) {
        $expectedPaths[$relative] = $true
        $item = Join-Path $extracted ($relative.Replace('/', '\'))
        if (-not (Test-Path -LiteralPath $item -PathType Leaf) -or (Get-Sha $item) -ne $expected[$relative]) {
            throw "Archived source verification failed: $relative"
        }
    }
    $expectedPaths['SOURCE_ARCHIVE_SHA256.txt'] = $true
    $extractedManifest = Join-Path $extracted 'SOURCE_ARCHIVE_SHA256.txt'
    if ((Get-Sha $extractedManifest) -ne (Get-Sha $archiveManifest)) { throw 'Archive SHA manifest differs' }
    $filesFound = @(Get-ChildItem -LiteralPath $extracted -File -Recurse)
    if ($filesFound.Count -ne $expectedPaths.Count) { throw "Unexpected archive file count: $($filesFound.Count)" }
    foreach ($found in $filesFound) {
        $relative = $found.FullName.Substring($extracted.Length + 1).Replace('\', '/')
        if (-not $expectedPaths.ContainsKey($relative)) { throw "Unexpected archive file: $relative" }
    }
    # Atomic-looking promotion: do not overwrite a previous good archive until verification finishes.
    Move-Item -LiteralPath $tempZip -Destination $zip -Force
    if (-not (Test-Path -LiteralPath $zip -PathType Leaf)) { throw 'Source ZIP promotion failed' }
    $zipHash = Get-Sha $zip
    Write-Host "Source archive: $zip" -ForegroundColor Green
    Write-Host "Source ZIP SHA256: $zipHash"
    Write-Host "Source files verified: $($expected.Count) plus SOURCE_ARCHIVE_SHA256.txt" -ForegroundColor Green
    exit 0
} catch {
    Write-Host ('SOURCE ARCHIVE FAILED: ' + $_.Exception.Message) -ForegroundColor Red
    exit 1
} finally {
    if ($stageRoot -and (Test-Path -LiteralPath $stageRoot)) {
        Remove-Item -LiteralPath $stageRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
    if ($checkRoot -and (Test-Path -LiteralPath $checkRoot)) {
        Remove-Item -LiteralPath $checkRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
