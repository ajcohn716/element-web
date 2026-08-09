# Copyright 2026 Element Creations Ltd.
#
# SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
# Please see LICENSE files in the repository root for full details.

param(
    [string]$Case,
    [string[]]$Cases,
    [switch]$Matrix,
    [switch]$Stress
)

$ErrorActionPreference = "Stop"
$bridgeDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$desktopDir = Resolve-Path (Join-Path $bridgeDir "..\..")
$toolDir = Resolve-Path (Join-Path $bridgeDir "..\windows-process-loopback")
$tool = Join-Path $toolDir "bin\windows-process-loopback.exe"
$electron = Join-Path $desktopDir "node_modules\electron\dist\electron.exe"
$main = Join-Path $bridgeDir "main.mjs"
$node = (Get-Command node.exe -ErrorAction Stop).Source
$wpr = Join-Path $env:SystemRoot "System32\wpr.exe"

$matrixCases = @(
    "malformed-source", "stale-hwnd", "dead-pid",
    "missing-exe", "exit-before-start", "init-reject", "unsupported-simulated",
    "crash-active", "stdout-close", "truncated", "malformed", "stall", "native-target-exit", "native-success",
    "adapter-burst", "queue-overflow", "bridge-destroy", "bridge-crash", "missing-worklet", "close-port",
    "audio-track-stop", "all-tracks-stop", "requester-navigate", "requester-close", "requester-crash",
    "replace-active", "replace-preparing", "cancel-startup", "cancel-prebuffer", "stale-preparation",
    "picker-cancel", "app-quit", "explicit-shutdown"
)
$stressCases = @(
    "native-success", "missing-exe", "native-success", "init-reject", "native-success",
    "malformed", "native-success", "crash-active", "native-success", "init-reject"
)

if (-not $Case -and -not $Cases -and -not $Matrix -and -not $Stress) {
    throw "Specify -Case <name>, -Cases <names>, -Matrix, or -Stress"
}

Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
& (Join-Path $toolDir "build.ps1") | Out-Null
$faultProducer = Join-Path $bridgeDir "r2-fault-producer.mjs"
& $node $faultProducer "exit-before-start"
if ($LASTEXITCODE -ne 21) { throw "R2 Node fault-producer preflight exited $LASTEXITCODE, expected 21" }

function Record-Descendants([int]$ParentPid, [Collections.Generic.HashSet[int]]$RecordedPids) {
    $parents = [Collections.Generic.Queue[int]]::new()
    $parents.Enqueue($ParentPid)
    while ($parents.Count -gt 0) {
        $parent = $parents.Dequeue()
        foreach ($child in Get-CimInstance Win32_Process -Filter "ParentProcessId=$parent" -ErrorAction SilentlyContinue) {
            if ($RecordedPids.Add([int]$child.ProcessId)) { $parents.Enqueue([int]$child.ProcessId) }
        }
    }
}

function Invoke-R2Case([string]$CaseName, [int]$Ordinal) {
    $runId = [Guid]::NewGuid().ToString("N")
    $profile = Join-Path $env:TEMP "element-r2-$CaseName-$runId"
    $stdoutLog = Join-Path $env:TEMP "element-r2-$CaseName-$runId.stdout.log"
    $stderrLog = Join-Path $env:TEMP "element-r2-$CaseName-$runId.stderr.log"
    $markerLog = Join-Path $env:TEMP "element-r2-$CaseName-$runId.markers.log"
    $etlLog = Join-Path $env:TEMP "element-r2-$CaseName-$runId.etl"
    $recordedPids = [Collections.Generic.HashSet[int]]::new()
    $target = $null
    $electronProcess = $null
    $passed = $false
    $wprStarted = $false
    try {
        New-Item -ItemType Directory -Force -Path $profile | Out-Null
        $targetPid = 0
        if ($CaseName -in @("native-target-exit", "native-success")) {
            $cmdExecutable = Join-Path $env:SystemRoot "System32\cmd.exe"
            $target = Start-Process $cmdExecutable -ArgumentList "/k" -PassThru -WindowStyle Hidden
            $targetPid = $target.Id
            if ($CaseName -eq "native-target-exit") { [void]$recordedPids.Add($target.Id) }
            Start-Sleep -Milliseconds 500
            $target.Refresh()
            if ($target.HasExited -or -not (Get-Process -Id $targetPid -ErrorAction SilentlyContinue)) {
                throw "Native target PID $targetPid was not live before Electron startup"
            }
        } elseif ($CaseName -eq "dead-pid") {
            $dead = Start-Process $node -ArgumentList @($faultProducer, "exit-before-start") -PassThru -WindowStyle Hidden
            $dead.WaitForExit()
            if ($dead.ExitCode -ne 21) { throw "Dead-PID fixture exited $($dead.ExitCode), expected 21" }
            $targetPid = $dead.Id
            if (Get-Process -Id $targetPid -ErrorAction SilentlyContinue) { throw "Dead-PID target $targetPid remained live" }
            [void]$recordedPids.Add($targetPid)
        }
        $arguments = @(
            "--user-data-dir=$profile", $main, "--r2-failures", "--r2-case=$CaseName",
            "--r2-node=$node", "--r2-target-pid=$targetPid", "--r2-marker-log=$markerLog"
        )
        if ($CaseName -eq "native-success") {
            & $wpr -start CPU -filemode | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "WPR CPU trace could not start; refusing blind native-success launch" }
            $wprStarted = $true
        }
        $electronProcess = Start-Process $electron -ArgumentList $arguments -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog
        $null = $electronProcess.Handle
        [void]$recordedPids.Add($electronProcess.Id)
        $clock = [Diagnostics.Stopwatch]::StartNew()
        while (-not $electronProcess.HasExited -and $clock.ElapsedMilliseconds -lt 12000) {
            Record-Descendants $electronProcess.Id $recordedPids
            Start-Sleep -Milliseconds 100
            $electronProcess.Refresh()
        }
        Record-Descendants $electronProcess.Id $recordedPids
        if (-not $electronProcess.HasExited) {
            Record-Descendants $electronProcess.Id $recordedPids
            $snapshot = @($recordedPids | Sort-Object | ForEach-Object {
                $process = Get-Process -Id $_ -ErrorAction SilentlyContinue
                $cimProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$_" -ErrorAction SilentlyContinue
                if ($null -ne $process) {
                    [pscustomobject]@{
                        pid = $process.Id
                        name = $process.ProcessName
                        parentPid = $cimProcess.ParentProcessId
                        cpuSeconds = $process.CPU
                        responding = $process.Responding
                        nativeHelper = ($cimProcess.Name -eq "windows-process-loopback.exe")
                    }
                }
            })
            if ($wprStarted) {
                & $wpr -stop $etlLog | Out-Null
                if ($LASTEXITCODE -ne 0) { throw "WPR failed to stop timeout trace $etlLog" }
                $wprStarted = $false
                Write-Output "R2_TIMEOUT_ETL $etlLog"
            }
            Write-Output "R2_TIMEOUT_SNAPSHOT case=$CaseName elapsedMs=$($clock.ElapsedMilliseconds) processes=$($snapshot | ConvertTo-Json -Compress)"
            throw "R2 case $CaseName exceeded 12000ms"
        }
        $electronProcess.WaitForExit()
        $electronProcess.Refresh()
        if ($wprStarted) {
            & $wpr -stop $etlLog | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "WPR failed to stop completed trace $etlLog" }
            $wprStarted = $false
        }
        $stdout = Get-Content -LiteralPath $stdoutLog -Raw -ErrorAction SilentlyContinue
        $stderr = Get-Content -LiteralPath $stderrLog -Raw -ErrorAction SilentlyContinue
        Write-Output $stdout
        if ($stderr) { Write-Warning $stderr }
        if ($electronProcess.ExitCode -ne 0) { throw "R2 case $CaseName exited $($electronProcess.ExitCode)" }
        if (-not "$stdout`n$stderr".Contains("R2_CASE_RESULT")) { throw "R2 case $CaseName omitted R2_CASE_RESULT" }
        $resultLine = @($stdout -split "`r?`n" | Where-Object { $_.StartsWith("R2_CASE_RESULT ") })[-1]
        $result = $resultLine.Substring("R2_CASE_RESULT ".Length) | ConvertFrom-Json
        if ($result.case -ne $CaseName -or $result.controllerState -ne "Idle" -or $null -ne $result.activeSession) {
            throw "R2 case $CaseName result identity/controller assertion failed"
        }
        foreach ($field in @("resources", "producerProcesses", "messagePorts", "bridgeWindows", "ownedTimers", "ownedListeners", "barriers", "staleMutations")) {
            if ($result.$field -ne 0) { throw "R2 case $CaseName result retained $field=$($result.$field)" }
        }
        foreach ($callback in $result.callbacks) {
            if ($callback.callbackCount -ne 1) { throw "R2 case $CaseName callback $($callback.id) count=$($callback.callbackCount)" }
        }
        if (-not $result.oracle.passed) { throw "R2 case $CaseName oracle did not pass" }
        if ($result.maxTeardownMilliseconds -gt 1500) { throw "R2 case $CaseName teardown exceeded 1500ms" }
        foreach ($producerPid in $result.producerPidHistory) { [void]$recordedPids.Add([int]$producerPid) }
        foreach ($processId in $recordedPids) {
            if (Get-Process -Id $processId -ErrorAction SilentlyContinue) {
                throw "R2 case $CaseName retained recorded PID $processId before cleanup"
            }
        }
        if ($CaseName -eq "native-success") {
            $target.Refresh()
            if ($target.HasExited -or -not (Get-Process -Id $targetPid -ErrorAction SilentlyContinue)) {
                throw "R2 native-success target PID $targetPid did not remain live through capture teardown"
            }
            Stop-Process -Id $targetPid -Force -ErrorAction Stop
            $target.WaitForExit(1500) | Out-Null
            if (Get-Process -Id $targetPid -ErrorAction SilentlyContinue) {
                throw "R2 native-success target PID $targetPid survived explicit runner cleanup"
            }
        }
        $passed = $true
        Write-Output "R2_RUN_RESULT ordinal=$Ordinal case=$CaseName elapsedMs=$($clock.ElapsedMilliseconds) PASS"
    } finally {
        if ($wprStarted) {
            & $wpr -stop $etlLog | Out-Null
            $wprStarted = $false
        }
        if ($null -ne $electronProcess) { Record-Descendants $electronProcess.Id $recordedPids }
        foreach ($processId in @($recordedPids | Sort-Object -Descending)) {
            Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
        }
        if ($null -ne $target -and -not $target.HasExited) { Stop-Process -Id $target.Id -Force -ErrorAction SilentlyContinue }
        $resolvedTemp = [IO.Path]::GetFullPath($env:TEMP)
        $resolvedProfile = [IO.Path]::GetFullPath($profile)
        if ($passed -and $resolvedProfile.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase) -and
            [IO.Path]::GetFileName($resolvedProfile).StartsWith("element-r2-")) {
            Remove-Item -LiteralPath $resolvedProfile -Recurse -Force -ErrorAction SilentlyContinue
            Remove-Item -LiteralPath $stdoutLog -Force -ErrorAction SilentlyContinue
            Remove-Item -LiteralPath $stderrLog -Force -ErrorAction SilentlyContinue
            Remove-Item -LiteralPath $markerLog -Force -ErrorAction SilentlyContinue
            Remove-Item -LiteralPath $etlLog -Force -ErrorAction SilentlyContinue
        } else {
            Add-Content -LiteralPath $stderrLog -Value "RUNNER case=$CaseName ordinal=$Ordinal"
            Write-Error "R2 failure artifacts preserved: $profile ; $stdoutLog ; $stderrLog ; $markerLog ; $etlLog" -ErrorAction Continue
        }
    }
}

$cases = [string[]]$(if ($Case) { ,$Case } elseif ($Cases) { $Cases } elseif ($Stress) { $stressCases } else { $matrixCases })
for ($index = 0; $index -lt $cases.Count; $index++) {
    Invoke-R2Case $cases[$index] ($index + 1)
}
