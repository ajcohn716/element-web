# Copyright 2026 Element Creations Ltd.
#
# SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
# Please see LICENSE files in the repository root for full details.

$ErrorActionPreference = "Stop"

if (-not [Environment]::Is64BitOperatingSystem) {
    throw "This experiment currently requires 64-bit Windows."
}

$compiler = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path -LiteralPath $compiler)) {
    throw "The .NET Framework C# compiler was not found at $compiler"
}

$experimentDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$outputDir = Join-Path $experimentDir "bin"
$outputPath = Join-Path $outputDir "windows-process-loopback.exe"

New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
& $compiler /nologo /optimize+ /platform:x64 "/out:$outputPath" (Join-Path $experimentDir "Program.cs")
if ($LASTEXITCODE -ne 0) {
    throw "C# compilation failed with exit code $LASTEXITCODE"
}

Write-Output $outputPath

