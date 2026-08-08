# Realtime PCM to display-media audio experiment

This isolated Electron 43.2.0 harness measures one candidate browser-media boundary:

    deterministic 48 kHz stereo PCM16 producer
        -> bounded MessageChannelMain / MessagePort (10 ms packets)
        -> sandboxed hidden renderer
        -> AudioWorklet (200 ms ring buffer)
        -> WebFrameMain audio capture
        -> setDisplayMediaRequestHandler
        -> getDisplayMedia audio MediaStreamTrack

It does not use WASAPI, global loopback, SharedArrayBuffer, a native addon, a helper process, LiveKit, MatrixRTC, or product code. The copied MessagePort boundary is what this harness is intended to measure. Its producer interface is deliberately independent of whether future PCM originates in an addon or helper.

Run from the repository root on Windows:

    apps\desktop\node_modules\.bin\electron.cmd apps\desktop\experiments\realtime-pcm-bridge\main.mjs

Use **Start capture** to obtain and analyze the actual returned track. All requests use Element Call's established application-audio constraints (`autoGainControl`, `noiseSuppression`, and `voiceIsolation` disabled). Use **Stop** before starting again, or **Run 10 cycles** for repeated lifecycle validation. Leave a session running for at least two minutes for the soak; queue counters update once per second. Close either window to exercise teardown.

For the deterministic ten-cycle plus two-minute run, including executable acceptance assertions:

    apps\desktop\node_modules\.bin\electron.cmd apps\desktop\experiments\realtime-pcm-bridge\main.mjs --automated

`--soak-ms=<milliseconds>` exists only for failure-path development; shorter runs are not acceptance evidence and can intentionally fail the underrun-percentage assertion before startup underruns amortize.

Expected security diagnostics are `sandboxed: true`, `contextIsolated: true`, and `nodeIntegrationVisibleInPage: false`. Only the bridge preload receives the PCM port, forwards it once with `window.postMessage`, and the page immediately transfers it into the AudioWorklet; page script is not the steady-state PCM path. The hidden bridge alone uses `backgroundThrottling: false` because its realtime worklet must continue while hidden.

Acceptance targets are one video and one audio track, a running 48000 Hz bridge AudioContext, non-silent 733 Hz audio at least 20 dB above 997 Hz, a queue that never exceeds 9600 frames, less than 1% post-start underruns and drops during a two-minute run, and estimated queued latency below 250 ms. `enableLocalEcho: false` asks Electron to mute local bridge playback while its frame is captured; audible behavior must be recorded during runtime testing.

The experiment's explicit Stop IPC closes tracks, the analysis context, producer port, worklet graph, bridge window, and session. Electron main has no reliable signal here for when Element Call stops a returned track, so this models but does not solve product unshare lifecycle ownership. Native addon versus helper process also remains undecided.

Static tests:

    node --test apps/desktop/experiments/realtime-pcm-bridge/pcm-core.test.mjs
    node --check apps/desktop/experiments/realtime-pcm-bridge/main.mjs

## Measured results

Validated on Windows with the repository's Electron 43.2.0 on 2026-08-08:

- Ten consecutive start/analyze/stop cycles each returned exactly one video track and one audio track. After the cycles there was one consumer window, no bridge window, and no active session.
- The bridge AudioContext ran while its window remained hidden, at the requested 48000 Hz, without a global autoplay switch.
- The returned audio track was labeled `Tab audio`. Its reported settings were `channelCount: 1`, `sampleRate: 48000`, `sampleSize: 16`, `autoGainControl: false`, `noiseSuppression: false`, `voiceIsolation: false`, and `echoCancellation: true`. `sampleSize` is a browser track setting, not proof that Chromium retains PCM16 as its internal encoding.
- Across the ten-cycle acceptance run, RMS was 0.1349 and 733 Hz was 54.2-58.9 dB above 997 Hz. The following two-minute run measured RMS 0.1349 and 59.6 dB separation.
- After 5,808,000 rendered frames, the queue had received 5,806,560 frames, with 4,320 startup-underrun frames (0.0744%), zero dropped frames, and zero discontinuities. It ended at 2,880 queued frames (60 ms), peaked at 4,320 frames (90 ms), and never exceeded its fixed 9,600-frame capacity. Producer in-flight packets were zero at the sample point.
- A deliberate 300 ms producer pause followed by catch-up caused silence underruns and oldest-frame drops as designed; the queue reached but did not exceed 9,600 frames and resumed rendering.
- Destroying the bridge window safely ended the captured audio track while the diagnostic video track remained live. Explicit Stop then removed the bridge and session.
- Cancelling before the display callback rejected getDisplayMedia with `NotReadableError`; no bridge window or active session remained.
- Runtime diagnostics reported sandboxing and context isolation enabled and Node integration unavailable to both page main worlds.

The mono result and enabled echo cancellation remain an unresolved application-audio fidelity risk despite the requested Element Call constraints being applied. They do not invalidate the feasibility result for transporting PCM through WebFrameMain into an ordinary MediaStreamTrack, but production work must determine whether Chromium's processing can or should be further constrained.

Automation confirmed `local_echo=false` in the captured track's device identifier. Whether any bridge tone is physically audible at the local output was not human-observed during the automated run, so local muting still needs an audible manual check.

If hidden-frame AudioContext resume, MessagePort transfer, WebFrameMain capture, or autoplay behaves differently on another system, record the reproducible failure rather than broadening this experiment.
