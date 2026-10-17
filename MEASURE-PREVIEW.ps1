# Preview 3: read-only measurement of TrayBin and its child WebView2 processes.
# Re-run in the same state as Preview 2 for a meaningful comparison.
param([ValidateRange(10,300)][int]$Seconds = 30)
$ErrorActionPreference = 'Stop'
$processes = @(Get-Process -Name 'traybin' -ErrorAction SilentlyContinue)
if ($processes.Count -ne 1) { throw "Expected exactly one TrayBin process, found $($processes.Count)." }
$rootPid = [int]$processes[0].Id
$baseline = @{}
$last = @{}
$ram = New-Object 'System.Collections.Generic.List[double]'
$peakChildren = 0

function Sample-Tree([int]$ParentPid) {
    # Native Win32_Process provides parent IDs. Only descendants of TrayBin count.
    $all = @(Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,Name -ErrorAction Stop)
    $ids = New-Object 'System.Collections.Generic.HashSet[int]'
    [void]$ids.Add($ParentPid)
    do {
        $changed = $false
        foreach ($item in $all) {
            if ($ids.Contains([int]$item.ParentProcessId) -and $ids.Add([int]$item.ProcessId)) {
                $changed = $true
            }
        }
    } while ($changed)
    $results = @()
    foreach ($id in $ids) {
        $proc = Get-Process -Id $id -ErrorAction SilentlyContinue
        if ($null -ne $proc) { $results += $proc }
    }
    return $results
}

Write-Host "Measuring TrayBin PID $rootPid (including child processes) for $Seconds seconds..." -ForegroundColor Cyan
for ($elapsed = 0; $elapsed -le $Seconds; $elapsed += 5) {
    if (-not (Get-Process -Id $rootPid -ErrorAction SilentlyContinue)) { throw 'TrayBin exited during measurement.' }
    $sample = @(Sample-Tree $rootPid)
    $sum = 0.0
    foreach ($proc in $sample) {
        $sum += [double]$proc.WorkingSet64
        $id = [int]$proc.Id
        $ticks = [double]$proc.CPU
        if (-not $baseline.ContainsKey($id)) { $baseline[$id] = $ticks }
        $last[$id] = $ticks
    }
    [void]$ram.Add([Math]::Round($sum / 1MB, 2))
    $peakChildren = [Math]::Max($peakChildren, [Math]::Max(0, $sample.Count - 1))
    if ($elapsed -lt $Seconds) { Start-Sleep -Seconds ([Math]::Min(5, $Seconds - $elapsed)) }
}
$cpu = 0.0
foreach ($id in $last.Keys) { $cpu += [Math]::Max(0, $last[$id] - $baseline[$id]) }
$min = ($ram | Measure-Object -Minimum).Minimum
$avg = [Math]::Round(($ram | Measure-Object -Average).Average, 2)
$max = ($ram | Measure-Object -Maximum).Maximum
Write-Host "Combined working set: min=$min MB, avg=$avg MB, max=$max MB" -ForegroundColor Green
Write-Host "CPU time of observed processes: $([Math]::Round($cpu, 3)) s / $Seconds s" -ForegroundColor Green
Write-Host "Peak child process count: $peakChildren" -ForegroundColor Green
Write-Host 'Note: summed working sets may double-count shared pages. Short-lived processes may be missed.'
