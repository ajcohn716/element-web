# Copyright 2026 Element Creations Ltd.
#
# SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
# Please see LICENSE files in the repository root for full details.

param([switch]$BootstrapOnly)

$ErrorActionPreference = "Stop"
$bridgeDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$desktopDir = Resolve-Path (Join-Path $bridgeDir "..\..")
$toolDir = Resolve-Path (Join-Path $bridgeDir "..\windows-process-loopback")
$tool = Join-Path $toolDir "bin\windows-process-loopback.exe"
$runId = [Guid]::NewGuid().ToString("N")
$profile = Join-Path $env:TEMP "element-real-producer-gate-$runId"
$stdoutLog = Join-Path $env:TEMP "element-real-producer-gate-$runId.stdout.log"
$stderrLog = Join-Path $env:TEMP "element-real-producer-gate-$runId.stderr.log"
$target = $null
$unrelated = $null
$electronProcess = $null
$recordedPids = [Collections.Generic.HashSet[int]]::new()
$passed = $false
$electron = $null
$main = $null
$sanitizedOrder = $null

function Record-Descendants([int]$ParentPid) {
    $parents = [Collections.Generic.Queue[int]]::new()
    $parents.Enqueue($ParentPid)
    while ($parents.Count -gt 0) {
        $parent = $parents.Dequeue()
        foreach ($child in Get-CimInstance Win32_Process -Filter "ParentProcessId=$parent" -ErrorAction SilentlyContinue) {
            if ($recordedPids.Add([int]$child.ProcessId)) { $parents.Enqueue([int]$child.ProcessId) }
        }
    }
}

try {
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    & (Join-Path $toolDir "build.ps1") | Out-Null
    New-Item -ItemType Directory -Force -Path $profile | Out-Null
    if (-not $BootstrapOnly) {
        $target = Start-Process $tool -ArgumentList "stereo-window-tone 180" -PassThru
        $unrelated = Start-Process $tool -ArgumentList "tone 1319 180" -PassThru -WindowStyle Hidden
        Start-Sleep -Seconds 2
    }
    $electron = Join-Path $desktopDir "node_modules\electron\dist\electron.exe"
    $main = Join-Path $bridgeDir "main.mjs"
    $arguments = @("--user-data-dir=$profile", $main, "--real-producer", "--automated-real")
    if ($BootstrapOnly) { $arguments += "--bootstrap-only" }
    else { $arguments += "--auto-window-pid=$($target.Id)" }
    $sanitizedOrder = if ($BootstrapOnly) {
        "--user-data-dir=<fresh> <main.mjs> --real-producer --automated-real --bootstrap-only"
    } else {
        "--user-data-dir=<fresh> <main.mjs> --real-producer --automated-real --auto-window-pid=<test>"
    }
    $electronProcess = Start-Process $electron -ArgumentList $arguments -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog
    $null = $electronProcess.Handle
    [void]$recordedPids.Add($electronProcess.Id)
    $deadline = [Diagnostics.Stopwatch]::StartNew()
    $deadlineMilliseconds = if ($BootstrapOnly) { 15000 } else { 40000 }
    while (-not $electronProcess.HasExited -and $deadline.ElapsedMilliseconds -lt $deadlineMilliseconds) {
        Record-Descendants $electronProcess.Id
        Start-Sleep -Milliseconds 200
        $electronProcess.Refresh()
    }
    Record-Descendants $electronProcess.Id
    if (-not $electronProcess.HasExited) { throw "Real-producer Electron launch exceeded its $deadlineMilliseconds ms process deadline" }
    $electronProcess.WaitForExit()
    $electronProcess.Refresh()
    $electronExitCode = $electronProcess.ExitCode
    $stdout = Get-Content -LiteralPath $stdoutLog -Raw -ErrorAction SilentlyContinue
    $stderr = Get-Content -LiteralPath $stderrLog -Raw -ErrorAction SilentlyContinue
    Write-Output $stdout
    if ($stderr) { Write-Error $stderr -ErrorAction Continue }
    if ($null -eq $electronExitCode) { throw "Real-producer Electron exit code was unavailable" }
    if ($electronExitCode -ne 0) { throw "Real-producer Electron gate failed with exit code $electronExitCode" }
    $requiredSignals = if ($BootstrapOnly) {
        @("REAL_BOOT route-entry", "REAL_BOOT module-entry", "REAL_BOOT before-app-ready", "REAL_BOOT after-app-ready", "REAL_BOOT consumer-loaded", "REAL_BOOT bootstrap-complete")
    } else {
        @("REAL_PRODUCER_GATE_ARMED", "REAL_PRODUCER_RESULTS", "REAL_PRODUCER_STARTUP_UNDERRUN")
    }
    $combinedOutput = "$stdout`n$stderr"
    foreach ($signal in $requiredSignals) {
        if (-not $combinedOutput.Contains($signal)) { throw "Real-producer Electron launch missed required signal $signal" }
    }
    foreach ($processId in $recordedPids) {
        if (Get-Process -Id $processId -ErrorAction SilentlyContinue) { throw "Recorded Electron/native PID $processId remained alive" }
    }
    $passed = $true
} finally {
    if ($null -ne $electronProcess) { Record-Descendants $electronProcess.Id }
    foreach ($processId in @($recordedPids | Sort-Object -Descending)) {
        Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
    }
    if ($null -ne $unrelated -and -not $unrelated.HasExited) { Stop-Process -Id $unrelated.Id -ErrorAction SilentlyContinue }
    if ($null -ne $target -and -not $target.HasExited) { Stop-Process -Id $target.Id -ErrorAction SilentlyContinue }
    $resolvedTemp = [IO.Path]::GetFullPath($env:TEMP)
    $resolvedProfile = [IO.Path]::GetFullPath($profile)
    if ($passed -and $resolvedProfile.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase) -and
        [IO.Path]::GetFileName($resolvedProfile).StartsWith("element-real-producer-gate-")) {
        Remove-Item -LiteralPath $resolvedProfile -Recurse -Force -ErrorAction SilentlyContinue
    }
    if ($passed) {
        Remove-Item -LiteralPath $stdoutLog -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $stderrLog -Force -ErrorAction SilentlyContinue
    } else {
        if ($electron) { Add-Content -LiteralPath $stderrLog -Value "RUNNER electron=$([IO.Path]::GetFullPath($electron))" }
        if ($main) { Add-Content -LiteralPath $stderrLog -Value "RUNNER main=$([IO.Path]::GetFullPath($main))" }
        if ($sanitizedOrder) { Add-Content -LiteralPath $stderrLog -Value "RUNNER args=$sanitizedOrder" }
        Write-Error "Failure artifacts preserved: $profile ; $stdoutLog ; $stderrLog" -ErrorAction Continue
    }
}
