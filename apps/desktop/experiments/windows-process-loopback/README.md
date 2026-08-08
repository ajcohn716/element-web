# Windows process-loopback experiment

This directory contains an isolated diagnostic for two assumptions needed by
Windows per-application screen-share audio:

1. An Electron `DesktopCapturerSource` ID for a window contains a Win32 `HWND`
   that can be resolved to its owning PID with `GetWindowThreadProcessId`.
2. WASAPI process-loopback capture can include or exclude a target process tree.

It has no Element, Electron, Node, LiveKit, or MatrixRTC integration. Generated
executables and WAV files are ignored and must not be committed.

## Requirements

- 64-bit Windows 10 build 20348 or later
- .NET Framework 4.x (the build script uses the inbox 64-bit C# compiler)

## Build

```powershell
./build.ps1
```

## Resolve a DesktopCapturerSource ID

```powershell
./bin/windows-process-loopback.exe source "window:525386:0"
```

The command reports only the source ID, numeric HWND, PID, and executable
basename. It never queries or logs the window title.

## Capture a process tree

```powershell
./bin/windows-process-loopback.exe capture 1234 include ./include.wav 10
```

## Capture everything except a process tree

```powershell
./bin/windows-process-loopback.exe capture 1234 exclude ./exclude.wav 10
```

The duration is optional and defaults to ten seconds. Press Ctrl+C to stop
early. Output is 48 kHz, stereo, signed 16-bit PCM. Shared-mode WASAPI performs
format conversion when the source stream uses another format. The diagnostic
also attempts `IAudioClient.GetMixFormat`; Windows may return `E_NOTIMPL` for
the process-loopback virtual device, in which case that fact is reported and
capture continues with the explicit PCM format.

The capture stops early if the target process exits. A successful capture may
contain only silence when the included process tree produces no audio.

## Deterministic validation tones

The executable can produce a quiet synthetic tone from its own process:

```powershell
./bin/windows-process-loopback.exe tone 440 10
```

It can also remain as the target parent and produce the tone from a child after
a delay, which is useful for verifying process-tree capture:

```powershell
./bin/windows-process-loopback.exe tone-tree 440 2 8
```
