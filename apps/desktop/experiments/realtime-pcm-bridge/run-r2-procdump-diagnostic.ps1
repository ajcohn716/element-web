# Copyright 2026 Element Creations Ltd.
#
# SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
# Please see LICENSE files in the repository root for full details.

param(
    [int]$MaximumAttempts = 1,
    [switch]$PreflightOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
if ($MaximumAttempts -lt 1) { throw "MaximumAttempts must be at least one" }

$procDump = "C:\Users\ajcoh\AppData\Local\Microsoft\WinGet\Packages\Microsoft.Sysinternals.Suite_Microsoft.Winget.Source_8wekyb3d8bbwe\procdump64.exe"
$bridgeDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$desktopDir = Resolve-Path (Join-Path $bridgeDir "..\..")
$toolDir = Resolve-Path (Join-Path $bridgeDir "..\windows-process-loopback")
$tool = (Resolve-Path (Join-Path $toolDir "bin\windows-process-loopback.exe")).Path
$electron = (Resolve-Path (Join-Path $desktopDir "node_modules\electron\dist\electron.exe")).Path
$main = (Resolve-Path (Join-Path $bridgeDir "main.mjs")).Path
$node = (Get-Command node.exe -ErrorAction Stop).Source
$faultProducer = (Resolve-Path (Join-Path $bridgeDir "r2-fault-producer.mjs")).Path
$diagnosticsRoot = Join-Path $env:LOCALAPPDATA "ElementScreenShareAudioDiagnostics"

function Get-ProcessIdentity([int]$ProcessId) {
    try {
        $process = Get-Process -Id $ProcessId -ErrorAction Stop
        $cim = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction Stop
        if ($null -eq $process -or $null -eq $cim -or $null -eq $process.StartTime) { return $null }
        [pscustomobject]@{
            pid = $ProcessId
            name = $cim.Name
            executablePath = $cim.ExecutablePath
            commandLine = $cim.CommandLine
            parentPid = $cim.ParentProcessId
            creationTimeUtc = $process.StartTime.ToUniversalTime().ToString("o")
            responding = $process.Responding
            cpuSeconds = $process.CPU
        }
    } catch {
        # Process-tree members may exit between enumeration and identity sampling.
        return $null
    }
}

function Write-DurableJson([string]$Path, [object]$Value) {
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($Value | ConvertTo-Json -Depth 8))
    $stream = [IO.FileStream]::new(
        $Path,
        [IO.FileMode]::Create,
        [IO.FileAccess]::Write,
        [IO.FileShare]::Read,
        4096,
        [IO.FileOptions]::WriteThrough
    )
    try {
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
    } finally {
        $stream.Dispose()
    }
}

function Test-IdentityMatch([object]$Expected, [object]$Current) {
    return $null -ne $Expected -and $null -ne $Current -and
        $Expected.pid -eq $Current.pid -and $Expected.creationTimeUtc -eq $Current.creationTimeUtc -and
        $Expected.executablePath -eq $Current.executablePath -and $Expected.commandLine -eq $Current.commandLine
}

function Get-ProcessTreeSnapshot([int]$RootPid) {
    $root = Get-ProcessIdentity $RootPid
    if ($null -eq $root) { return @() }
    $pending = [Collections.Generic.Queue[object]]::new()
    $seen = [Collections.Generic.HashSet[int]]::new()
    $result = [Collections.Generic.List[object]]::new()
    $pending.Enqueue($root)
    while ($pending.Count -gt 0) {
        $parent = $pending.Dequeue()
        if (-not $seen.Add([int]$parent.pid)) { continue }
        $currentParent = Get-ProcessIdentity ([int]$parent.pid)
        if (-not (Test-IdentityMatch $parent $currentParent)) { continue }
        $result.Add($parent)
        foreach ($child in Get-CimInstance Win32_Process -Filter "ParentProcessId=$($parent.pid)" -ErrorAction SilentlyContinue) {
            $childIdentity = Get-ProcessIdentity ([int]$child.ProcessId)
            if ($null -ne $childIdentity -and $childIdentity.parentPid -eq $parent.pid -and
                [datetime]::Parse($childIdentity.creationTimeUtc) -ge [datetime]::Parse($parent.creationTimeUtc)) {
                $pending.Enqueue($childIdentity)
            }
        }
    }
    return @($result)
}

function Get-VerifiedElectronTreeSnapshot(
    [object]$RootIdentity,
    [Diagnostics.Process]$RootProcess,
    [string]$RunToken,
    [string]$MismatchPath
) {
    $firstCurrentRoot = Get-ProcessIdentity ([int]$RootIdentity.pid)
    if (-not (Test-IdentityMatch $RootIdentity $firstCurrentRoot)) {
        $RootProcess.Refresh()
        if ($RootProcess.HasExited) { return @() }
        Start-Sleep -Milliseconds 25
        $secondCurrentRoot = Get-ProcessIdentity ([int]$RootIdentity.pid)
        $RootProcess.Refresh()
        if ($RootProcess.HasExited) { return @() }
        if (-not (Test-IdentityMatch $RootIdentity $secondCurrentRoot)) {
            [ordered]@{
                observedAtUtc = [datetime]::UtcNow.ToString("o")
                expected = $RootIdentity
                firstCurrent = $firstCurrentRoot
                secondCurrent = $secondCurrentRoot
                originalHandleExited = $RootProcess.HasExited
            } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $MismatchPath -Encoding utf8
            throw "Electron root identity remained mismatched while the original process handle was alive"
        }
    }
    $rootKey = "$($RootIdentity.pid)|$($RootIdentity.creationTimeUtc)|$RunToken"
    $pending = [Collections.Generic.Queue[object]]::new()
    $seen = [Collections.Generic.HashSet[string]]::new()
    $result = [Collections.Generic.List[object]]::new()
    $pending.Enqueue($RootIdentity)
    while ($pending.Count -gt 0) {
        $parent = $pending.Dequeue()
        $parentKey = "$($parent.pid)|$($parent.creationTimeUtc)"
        if (-not $seen.Add($parentKey)) { continue }
        $currentParent = Get-ProcessIdentity ([int]$parent.pid)
        if (-not (Test-IdentityMatch $parent $currentParent)) { continue }
        $result.Add([pscustomobject]@{
            pid = $parent.pid; name = $parent.name; executablePath = $parent.executablePath; commandLine = $parent.commandLine
            parentPid = $parent.parentPid; creationTimeUtc = $parent.creationTimeUtc; responding = $parent.responding; cpuSeconds = $parent.cpuSeconds
            rootAncestryKey = $rootKey; parentIdentityKey = if ($parent.pid -eq $RootIdentity.pid) { $null } else { $parent.parentIdentityKey }
        })
        foreach ($child in Get-CimInstance Win32_Process -Filter "ParentProcessId=$($parent.pid)" -ErrorAction SilentlyContinue) {
            $childIdentity = Get-ProcessIdentity ([int]$child.ProcessId)
            if ($null -eq $childIdentity -or $childIdentity.parentPid -ne $parent.pid -or
                [datetime]::Parse($childIdentity.creationTimeUtc) -lt [datetime]::Parse($parent.creationTimeUtc)) { continue }
            $isNative = $childIdentity.name -eq "windows-process-loopback.exe"
            $expectedPath = if ($isNative) { $tool } else { $electron }
            if (-not $childIdentity.executablePath -or
                -not [IO.Path]::GetFullPath($childIdentity.executablePath).Equals([IO.Path]::GetFullPath($expectedPath), [StringComparison]::OrdinalIgnoreCase)) {
                throw "Electron tree child PID $($childIdentity.pid) executable shape mismatch"
            }
            $pending.Enqueue([pscustomobject]@{
                pid = $childIdentity.pid; name = $childIdentity.name; executablePath = $childIdentity.executablePath; commandLine = $childIdentity.commandLine
                parentPid = $childIdentity.parentPid; creationTimeUtc = $childIdentity.creationTimeUtc; responding = $childIdentity.responding; cpuSeconds = $childIdentity.cpuSeconds
                rootAncestryKey = $rootKey; parentIdentityKey = $parentKey
            })
        }
    }
    return @($result)
}

function Test-IdentityLive([object]$Identity) {
    if ($null -eq $Identity) { return $false }
    $current = Get-ProcessIdentity ([int]$Identity.pid)
    if ($null -eq $current) { return $false }
    return Test-IdentityMatch $Identity $current
}

function Add-IdentityHistory([hashtable]$History, [object[]]$Identities) {
    foreach ($identity in $Identities) {
        if ($null -ne $identity) {
            $identityKey = "$($identity.pid)|$($identity.creationTimeUtc)"
            if (-not $History.ContainsKey($identityKey)) { $History[$identityKey] = $identity }
        }
    }
}

function Assert-MainIdentity([Diagnostics.Process]$Process, [string]$Token, [datetime]$StartedAfterUtc) {
    if ($Process.HasExited) { throw "Electron main PID $($Process.Id) exited before identity validation" }
    $identity = Get-ProcessIdentity $Process.Id
    if ($null -eq $identity) { throw "Electron main PID $($Process.Id) cannot be resolved" }
    if (-not [IO.Path]::GetFullPath($identity.executablePath).Equals($electron, [StringComparison]::OrdinalIgnoreCase)) {
        throw "PID $($Process.Id) executable identity mismatch"
    }
    if (-not $identity.commandLine.Contains($Token) -or -not $identity.commandLine.Contains($main) -or $identity.commandLine.Contains("--type=")) {
        throw "PID $($Process.Id) command-line identity mismatch"
    }
    if ([datetime]::Parse($identity.creationTimeUtc).ToUniversalTime() -lt $StartedAfterUtc.AddSeconds(-1)) {
        throw "PID $($Process.Id) creation time predates this diagnostic run"
    }
    return $identity
}

function Get-StableDump([string]$Directory, [datetime]$StartedUtc) {
    $candidates = @(Get-ChildItem -LiteralPath $Directory -Filter *.dmp -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Length -gt 0 -and $_.LastWriteTimeUtc -ge $StartedUtc.AddSeconds(-1) })
    if ($candidates.Count -ne 1) { throw "Expected exactly one new nonempty MDMP dump; found $($candidates.Count)" }
    $dump = $candidates[0]
    $header = [byte[]]::new(32)
    $stream = [IO.File]::Open($dump.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        if ($stream.Read($header, 0, $header.Length) -ne $header.Length -or [Text.Encoding]::ASCII.GetString($header, 0, 4) -ne "MDMP") {
            throw "Dump lacks a complete MDMP header"
        }
        $streamCount = [BitConverter]::ToUInt32($header, 8)
        $directoryRva = [BitConverter]::ToUInt32($header, 12)
        $directoryBytes = [uint64]$streamCount * 12
        if ($streamCount -eq 0 -or $streamCount -gt 65535 -or [uint64]$directoryRva + $directoryBytes -gt [uint64]$dump.Length) {
            throw "MDMP stream directory is out of bounds"
        }
        $stream.Position = $directoryRva
        $entry = [byte[]]::new(12)
        for ($streamIndex = 0; $streamIndex -lt $streamCount; $streamIndex++) {
            if ($stream.Read($entry, 0, 12) -ne 12) { throw "MDMP stream directory is truncated" }
            $dataSize = [BitConverter]::ToUInt32($entry, 4)
            $dataRva = [BitConverter]::ToUInt32($entry, 8)
            if ($dataSize -gt 0 -and [uint64]$dataRva + [uint64]$dataSize -gt [uint64]$dump.Length) {
                throw "MDMP stream $streamIndex location is out of bounds"
            }
        }
    }
    finally { $stream.Dispose() }
    $firstLength = $dump.Length
    $firstWrite = $dump.LastWriteTimeUtc
    Start-Sleep -Milliseconds 750
    $dump.Refresh()
    if ($dump.Length -ne $firstLength -or $dump.LastWriteTimeUtc -ne $firstWrite) { throw "Dump was not stable after ProcDump completion" }
    return $dump
}

function Read-ProcDumpText([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return "" }
    $bytes = [IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -eq 0) { return "" }
    $zeroOddBytes = 0
    for ($index = 1; $index -lt [Math]::Min($bytes.Length, 512); $index += 2) {
        if ($bytes[$index] -eq 0) { $zeroOddBytes += 1 }
    }
    if ($zeroOddBytes -ge 4) { return [Text.Encoding]::Unicode.GetString($bytes) }
    return [Text.Encoding]::UTF8.GetString($bytes)
}

function Invoke-ProcDump([int]$ProcessId, [string]$DumpDirectory, [switch]$ProcessTree) {
    $stdout = Join-Path $DumpDirectory "procdump.stdout.log"
    $stderr = Join-Path $DumpDirectory "procdump.stderr.log"
    $arguments = @("-accepteula", "-ma")
    if ($ProcessTree) { $arguments += "-pt" }
    $arguments += @($ProcessId, $DumpDirectory)
    $startedUtc = [datetime]::UtcNow
    $capture = Start-Process $procDump -ArgumentList $arguments -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    $null = $capture.Handle
    if (-not $capture.WaitForExit(120000)) {
        Stop-Process -Id $capture.Id -Force -ErrorAction SilentlyContinue
        throw "ProcDump PID $($capture.Id) did not complete within 120 seconds"
    }
    $capture.WaitForExit()
    $capture.Refresh()
    $completion = "$(Read-ProcDumpText $stdout)`n$(Read-ProcDumpText $stderr)"
    if ($capture.ExitCode -ne 1) { throw "ProcDump v12.01 composite contract expected raw exit 1, got $($capture.ExitCode)" }
    if (-not $completion.Contains("Dump 1 complete") -or -not $completion.Contains("Dump count reached")) {
        throw "ProcDump did not report both completion signals"
    }
    if ($completion -match "(?i)\b(error|failed|failure|access denied|unable to)\b") {
        throw "ProcDump output contained failure text"
    }
    $dump = Get-StableDump $DumpDirectory $startedUtc
    return [pscustomobject]@{ dump = $dump; rawExitCode = $capture.ExitCode; completionSignals = @("Dump 1 complete", "Dump count reached") }
}

function Invoke-ProcDumpPreflight {
    if (-not (Test-Path -LiteralPath $procDump -PathType Leaf)) { throw "ProcDump executable is missing: $procDump" }
    $preflightId = [Guid]::NewGuid().ToString("N")
    $preflightDir = Join-Path $env:TEMP "element-r2-procdump-preflight-$preflightId"
    $benign = $null
    $verified = $false
    try {
        New-Item -ItemType Directory -Path $preflightDir | Out-Null
        $helpOut = Join-Path $preflightDir "version.stdout.log"
        $helpErr = Join-Path $preflightDir "version.stderr.log"
        $help = Start-Process $procDump -ArgumentList @("-accepteula", "-?") -PassThru -WindowStyle Hidden -RedirectStandardOutput $helpOut -RedirectStandardError $helpErr
        $null = $help.Handle
        $help.WaitForExit()
        $versionText = "$(Read-ProcDumpText $helpOut)`n$(Read-ProcDumpText $helpErr)"
        if (-not $versionText.Contains("ProcDump v12.01")) { throw "Expected ProcDump v12.01" }
        $benign = Start-Process (Join-Path $env:SystemRoot "System32\cmd.exe") -ArgumentList "/k" -PassThru -WindowStyle Hidden
        Start-Sleep -Milliseconds 200
        if ($benign.HasExited) { throw "Disposable ProcDump preflight process exited before capture" }
        $captureResult = Invoke-ProcDump $benign.Id $preflightDir
        $dump = $captureResult.dump
        $verified = $true
        Write-Output "R2_PROCDUMP_PREFLIGHT version=12.01 rawExit=$($captureResult.rawExitCode) bytes=$($dump.Length) completion=exact-composite PASS"
    } finally {
        if ($null -ne $benign -and -not $benign.HasExited) { Stop-Process -Id $benign.Id -Force -ErrorAction SilentlyContinue }
        $resolvedTemp = [IO.Path]::GetFullPath($env:TEMP)
        $resolvedPreflight = [IO.Path]::GetFullPath($preflightDir)
        if ($verified -and $resolvedPreflight.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase) -and
            [IO.Path]::GetFileName($resolvedPreflight).StartsWith("element-r2-procdump-preflight-$preflightId")) {
            Remove-Item -LiteralPath $resolvedPreflight -Recurse -Force -ErrorAction SilentlyContinue
        } elseif (-not $verified) {
            Write-Warning "ProcDump preflight artifacts preserved: $preflightDir"
        }
    }
}

function Stop-ExactIdentities([object[]]$Identities) {
    $byPid = @{}
    foreach ($identity in $Identities) {
        if ($null -eq $identity) { continue }
        $identityPid = [int]$identity.pid
        if (-not $byPid.ContainsKey($identityPid)) { $byPid[$identityPid] = [Collections.Generic.List[object]]::new() }
        $byPid[$identityPid].Add($identity)
    }
    foreach ($identityPid in @($byPid.Keys | Sort-Object -Descending)) {
        $current = Get-ProcessIdentity $identityPid
        if ($null -eq $current) { continue }
        $matchesStoredIdentity = @($byPid[$identityPid] | Where-Object {
            $_.creationTimeUtc -eq $current.creationTimeUtc -and $_.executablePath -eq $current.executablePath -and $_.commandLine -eq $current.commandLine
        }).Count -gt 0
        if ($matchesStoredIdentity) { Stop-Process -Id $identityPid -Force -ErrorAction SilentlyContinue }
    }
    Start-Sleep -Milliseconds 300
    $survivors = @($Identities | Where-Object { Test-IdentityLive $_ })
    if ($survivors.Count -ne 0) { throw "Experiment process cleanup retained exact identities: $($survivors.pid -join ',')" }
}

Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Invoke-ProcDumpPreflight
if ($PreflightOnly) { exit 0 }
& (Join-Path $toolDir "build.ps1") | Out-Null
& $node $faultProducer "exit-before-start"
if ($LASTEXITCODE -ne 21) { throw "R2 fault-producer preflight exited $LASTEXITCODE, expected 21" }
New-Item -ItemType Directory -Force -Path $diagnosticsRoot | Out-Null

for ($attempt = 1; $attempt -le $MaximumAttempts; $attempt++) {
    $runId = [Guid]::NewGuid().ToString("N")
    $token = "--r2-diagnostic-token=$runId"
    $runDir = Join-Path $diagnosticsRoot "native-success-$runId"
    $profile = Join-Path $runDir "profile"
    $stdoutLog = Join-Path $runDir "electron.stdout.log"
    $stderrLog = Join-Path $runDir "electron.stderr.log"
    $markerLog = Join-Path $runDir "sync-boundaries.markers.log"
    $snapshotPath = Join-Path $runDir "freeze-process-snapshot.json"
    $freezeRecordPath = Join-Path $runDir "watchdog-freeze.json"
    $rootMismatchPath = Join-Path $runDir "root-identity-mismatch.json"
    $manifestPath = Join-Path $runDir "manifest.json"
    $target = $null
    $electronProcess = $null
    $initialIdentity = $null
    $dumpCaptured = $false
    $provenFrozen = $false
    $dumpAttemptsExhausted = $false
    $diagnosticStage = "setup"
    $captureErrorText = $null
    $frozenSnapshot = @()
    $electronIdentityHistory = @{}
    $nativeIdentityHistory = @{}
    $targetIdentityHistory = @{}
    try {
        New-Item -ItemType Directory -Path $runDir | Out-Null
        New-Item -ItemType Directory -Path $profile | Out-Null
        $target = Start-Process (Join-Path $env:SystemRoot "System32\cmd.exe") -ArgumentList "/k" -PassThru -WindowStyle Hidden
        Start-Sleep -Milliseconds 500
        if ($target.HasExited) { throw "Native target exited before Electron startup" }
        Add-IdentityHistory $targetIdentityHistory @(Get-ProcessTreeSnapshot $target.Id)
        $startedAfterUtc = [datetime]::UtcNow
        $arguments = @(
            "--user-data-dir=$profile", $main, "--r2-failures", "--r2-case=native-success",
            "--r2-node=$node", "--r2-target-pid=$($target.Id)", "--r2-marker-log=$markerLog", $token
        )
        $electronProcess = Start-Process $electron -ArgumentList $arguments -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog
        $null = $electronProcess.Handle
        $initialIdentity = Assert-MainIdentity $electronProcess $token $startedAfterUtc
        Add-IdentityHistory $electronIdentityHistory @(Get-VerifiedElectronTreeSnapshot $initialIdentity $electronProcess $token $rootMismatchPath)
        $clock = [Diagnostics.Stopwatch]::StartNew()
        $lastHeartbeatSeenAt = $null
        $lastHeartbeatCount = -1
        $hasResult = $false
        while (-not $electronProcess.HasExited -and $clock.ElapsedMilliseconds -lt 12000) {
            foreach ($identity in Get-VerifiedElectronTreeSnapshot $initialIdentity $electronProcess $token $rootMismatchPath) {
                if ($identity.name -eq "windows-process-loopback.exe") {
                    if (-not $identity.executablePath -or -not [IO.Path]::GetFullPath($identity.executablePath).Equals([IO.Path]::GetFullPath($tool), [StringComparison]::OrdinalIgnoreCase)) {
                        throw "Native helper PID $($identity.pid) executable identity mismatch"
                    }
                    Add-IdentityHistory $nativeIdentityHistory @($identity)
                }
                else {
                    Add-IdentityHistory $electronIdentityHistory @($identity)
                }
            }
            Start-Sleep -Milliseconds 100
            $electronProcess.Refresh()
            [string]$stdout = Get-Content -LiteralPath $stdoutLog -Raw -ErrorAction SilentlyContinue
            $hasResult = $stdout.Contains("R2_CASE_RESULT")
            $heartbeats = @([regex]::Matches($stdout, 'R2_PHASE\s+\{"phase":"main-heartbeat","count":(\d+)'))
            if ($heartbeats.Count -gt 0) {
                $observed = [int]$heartbeats[-1].Groups[1].Value
                if ($observed -ne $lastHeartbeatCount) {
                    $lastHeartbeatCount = $observed
                    $lastHeartbeatSeenAt = [datetime]::UtcNow
                }
            }
        }
        if ($electronProcess.HasExited) {
            $electronProcess.WaitForExit()
            $electronProcess.Refresh()
            [string]$stdout = Get-Content -LiteralPath $stdoutLog -Raw -ErrorAction SilentlyContinue
            if ($electronProcess.ExitCode -ne 0 -or -not $stdout.Contains("R2_CASE_RESULT")) {
                throw "native-success exited without a passing structured result"
            }
            $resultLine = @($stdout -split "`r?`n" | Where-Object { $_.StartsWith("R2_CASE_RESULT ") })[-1]
            $result = $resultLine.Substring("R2_CASE_RESULT ".Length) | ConvertFrom-Json
            if ($result.case -ne "native-success" -or $result.controllerState -ne "Idle" -or $null -ne $result.activeSession) {
                throw "native-success structured identity/controller oracle failed"
            }
            foreach ($field in @("resources", "producerProcesses", "messagePorts", "bridgeWindows", "ownedTimers", "ownedListeners", "barriers", "staleMutations", "staleCompletions")) {
                if ($result.$field -ne 0) { throw "native-success structured oracle retained $field=$($result.$field)" }
            }
            foreach ($callback in $result.callbacks) {
                if ($callback.callbackCount -ne 1) { throw "native-success callback $($callback.id) count=$($callback.callbackCount)" }
            }
            if (-not $result.oracle.passed -or $result.maxTeardownMilliseconds -gt 1500) {
                throw "native-success structured acceptance oracle failed"
            }
            $quiescence = [Diagnostics.Stopwatch]::StartNew()
            do {
                $survivingIdentities = @((@($electronIdentityHistory.Values) + @($nativeIdentityHistory.Values)) | Where-Object { Test-IdentityLive $_ })
                if ($survivingIdentities.Count -eq 0) { break }
                Start-Sleep -Milliseconds 25
            } while ($quiescence.ElapsedMilliseconds -lt 1500)
            $survivingIdentities = @((@($electronIdentityHistory.Values) + @($nativeIdentityHistory.Values)) | Where-Object { Test-IdentityLive $_ })
            if ($survivingIdentities.Count -ne 0) {
                $result | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $runDir "structured-result.json") -Encoding utf8
                [ordered]@{
                    quiescenceElapsedMilliseconds = $quiescence.ElapsedMilliseconds
                    survivorIdentities = $survivingIdentities
                } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $runDir "teardown-survivors.json") -Encoding utf8
                throw "Structured success retained exact identities after 1500ms: $($survivingIdentities.pid -join ',')"
            }
            Write-Output "R2_PROCDUMP_ATTEMPT attempt=$attempt result=no-freeze elapsedMs=$($clock.ElapsedMilliseconds) processDrainMs=$($quiescence.ElapsedMilliseconds)"
            Stop-ExactIdentities @($targetIdentityHistory.Values)
            continue
        }
        $heartbeatAge = if ($null -eq $lastHeartbeatSeenAt) { [double]::PositiveInfinity } else { ([datetime]::UtcNow - $lastHeartbeatSeenAt).TotalSeconds }
        [string]$stdout = Get-Content -LiteralPath $stdoutLog -Raw -ErrorAction SilentlyContinue
        $hasResult = $stdout.Contains("R2_CASE_RESULT")
        if ($hasResult -or $clock.ElapsedMilliseconds -lt 12000 -or $null -eq $lastHeartbeatSeenAt -or $heartbeatAge -lt 2) {
            throw "Watchdog did not prove the known freeze (alive=$(-not $electronProcess.HasExited) result=$hasResult heartbeat=$lastHeartbeatCount heartbeatAgeSeconds=$heartbeatAge)"
        }
        $diagnosticStage = "freeze-identity-validated"
        $frozenIdentity = Assert-MainIdentity $electronProcess $token $startedAfterUtc
        $provenFrozen = $true
        $diagnosticStage = "freeze-snapshot"
        $frozenSnapshot = Get-VerifiedElectronTreeSnapshot $initialIdentity $electronProcess $token $rootMismatchPath
        foreach ($identity in $frozenSnapshot) {
            if ($identity.name -eq "windows-process-loopback.exe") {
                if (-not $identity.executablePath -or -not [IO.Path]::GetFullPath($identity.executablePath).Equals([IO.Path]::GetFullPath($tool), [StringComparison]::OrdinalIgnoreCase)) {
                    throw "Frozen native helper PID $($identity.pid) executable identity mismatch"
                }
                Add-IdentityHistory $nativeIdentityHistory @($identity)
            }
            else {
                Add-IdentityHistory $electronIdentityHistory @($identity)
            }
        }
        $frozenSnapshot | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $snapshotPath -Encoding utf8
        $diagnosticStage = "watchdog-freeze-record"
        Write-DurableJson $freezeRecordPath ([ordered]@{
            schemaVersion = 1
            classification = "known-main-liveness-failure"
            recordedAtUtc = [datetime]::UtcNow.ToString("o")
            runId = $runId
            watchdog = [ordered]@{
                elapsedMilliseconds = $clock.ElapsedMilliseconds
                resultSeen = $hasResult
                lastHeartbeatCount = $lastHeartbeatCount
                heartbeatAgeSeconds = $heartbeatAge
            }
            electronMain = $frozenIdentity
            initialElectronMain = $initialIdentity
            processSnapshot = $frozenSnapshot
        })
        $markerLines = @(Get-Content -LiteralPath $markerLog -ErrorAction SilentlyContinue)
        $lastMarker = if ($markerLines.Count -gt 0) { $markerLines[-1] } else { $null }
        $captureResult = $null
        $dump = $null
        $captureError = $null
        foreach ($captureAttempt in 1..2) {
            try {
                $diagnosticStage = "procdump-attempt-$captureAttempt"
                Assert-MainIdentity $electronProcess $token $startedAfterUtc | Out-Null
                $captureDirectory = Join-Path $runDir "dump-capture-$captureAttempt"
                New-Item -ItemType Directory -Path $captureDirectory | Out-Null
                $captureResult = Invoke-ProcDump $electronProcess.Id $captureDirectory -ProcessTree
                $dump = $captureResult.dump
                $captureError = $null
                break
            } catch {
                $captureError = $_
                $captureErrorText = $_.Exception.ToString()
                if ($captureAttempt -eq 1 -and -not $electronProcess.HasExited) { continue }
                $dumpAttemptsExhausted = $true
                throw
            }
        }
        if ($null -ne $captureError -or $null -eq $dump) {
            $dumpAttemptsExhausted = $true
            throw "ProcDump capture failed"
        }
        $hash = Get-FileHash -LiteralPath $dump.FullName -Algorithm SHA256
        $analyzers = @("windbg.exe", "windbgx.exe", "cdb.exe", "kd.exe") | ForEach-Object {
            $command = Get-Command $_ -ErrorAction SilentlyContinue
            if ($null -ne $command) { $command.Source }
        }
        $manifest = [ordered]@{
            schemaVersion = 1
            dumpCaptured = $true
            capturedAtUtc = [datetime]::UtcNow.ToString("o")
            runId = $runId
            electronMain = $frozenIdentity
            initialElectronMain = $initialIdentity
            nativeTarget = Get-ProcessIdentity $target.Id
            childProcesses = $frozenSnapshot
            electronIdentityHistory = @($electronIdentityHistory.Values)
            nativeIdentityHistory = @($nativeIdentityHistory.Values)
            watchdog = [ordered]@{ elapsedMilliseconds = $clock.ElapsedMilliseconds; resultSeen = $hasResult; lastHeartbeatCount = $lastHeartbeatCount; heartbeatAgeSeconds = $heartbeatAge }
            lastDurableMarker = $lastMarker
            dump = [ordered]@{ relativePath = "dump-capture-$captureAttempt\$($dump.Name)"; bytes = $dump.Length; sha256 = $hash.Hash; lastWriteTimeUtc = $dump.LastWriteTimeUtc.ToString("o"); format = "MDMP"; processTreeStreamRequested = $true; procDumpVersion = "12.01"; rawExitCode = $captureResult.rawExitCode; completionSignals = $captureResult.completionSignals }
            analyzersDiscovered = @($analyzers)
        }
        $manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $manifestPath -Encoding utf8
        $dumpCaptured = $true
        Write-Output "R2_FROZEN_DUMP directory=$runDir file=$($dump.FullName) bytes=$($dump.Length) sha256=$($hash.Hash) lastMarker=$lastMarker"
    } finally {
        if ($null -ne $electronProcess -and $null -ne $initialIdentity -and -not $electronProcess.HasExited -and $frozenSnapshot.Count -eq 0) {
            $frozenSnapshot = Get-VerifiedElectronTreeSnapshot $initialIdentity $electronProcess $token $rootMismatchPath
        }
        if ($provenFrozen -and -not $dumpCaptured) {
            $liveExactIdentities = @((@($electronIdentityHistory.Values) + @($nativeIdentityHistory.Values) + @($targetIdentityHistory.Values) + @($frozenSnapshot)) | Where-Object { Test-IdentityLive $_ })
            $carry = [ordered]@{
                captureFailed = $true
                runId = $runId
                diagnosticStage = $diagnosticStage
                captureError = $captureErrorText
                dumpAttemptsExhausted = $dumpAttemptsExhausted
                electronMain = $frozenIdentity
                electronIdentityHistory = @($electronIdentityHistory.Values)
                nativeIdentityHistory = @($nativeIdentityHistory.Values)
                nativeTargetHistory = @($targetIdentityHistory.Values)
                liveExactIdentities = $liveExactIdentities
            }
            $carry | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $runDir "human-cleanup-required.json") -Encoding utf8
            Write-Warning "Proven frozen Electron main was not terminated without a verified dump: PID $($frozenIdentity.pid); stage=$diagnosticStage attemptsExhausted=$dumpAttemptsExhausted artifacts=$runDir"
        } else {
            if ($null -ne $target -and -not $target.HasExited) { Add-IdentityHistory $targetIdentityHistory @(Get-ProcessTreeSnapshot $target.Id) }
            Stop-ExactIdentities (@($electronIdentityHistory.Values) + @($nativeIdentityHistory.Values) + @($targetIdentityHistory.Values) + @($frozenSnapshot))
            $tokenSurvivors = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($token) })
            if ($tokenSurvivors.Count -ne 0) { throw "Diagnostic token survived cleanup in PIDs $($tokenSurvivors.ProcessId -join ',')" }
        }
    }
    if ($dumpCaptured) {
        Write-Error "R2 known freeze captured; diagnostic run intentionally exits nonzero and stops reproduction" -ErrorAction Continue
        exit 3
    }
}

Write-Error "No freeze was captured in $MaximumAttempts isolated attempt(s); this is not resolution" -ErrorAction Continue
exit 2
