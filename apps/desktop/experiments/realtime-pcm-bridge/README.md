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

The experiment's explicit Stop IPC closes tracks, the analysis context, producer port, worklet graph, bridge window, and session. The lifecycle mode below subsequently establishes a reliable Electron-main observation for returned audio-track consumption. Native addon versus helper process remains undecided.

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

## Lifecycle and fidelity modes

The lifecycle stage remains isolated from product and WASAPI code:

    apps\desktop\node_modules\.bin\electron.cmd apps\desktop\experiments\realtime-pcm-bridge\main.mjs --lifecycle
    apps\desktop\node_modules\.bin\electron.cmd apps\desktop\experiments\realtime-pcm-bridge\main.mjs --fidelity

`--lifecycle` is main-driven so it can recreate requesters after navigation or a renderer crash. It uses a 50 ms `WebContents.isBeingCaptured()` poll, waits until capture has first been observed, requires two subsequent false samples, and enforces a one-second teardown deadline. `--fidelity` uses 733 Hz in the producer's left channel and 997 Hz in its right channel and analyzes both outputs of a `ChannelSplitterNode`.

### Current product lifecycle trace

The current source-derived path is:

1. Element Call's bundled `LocalMember.toggleScreenSharing()` calls LiveKit `setScreenShareEnabled()` with display audio constraints.
2. LiveKit `createLocalScreenTracks()` calls `navigator.mediaDevices.getDisplayMedia()`.
3. `apps/desktop/src/electron-main.ts` receives the request, including its requesting `WebFrameMain`, in `setDisplayMediaRequestHandler` and asks the outer Element renderer to open the source picker.
4. `apps/web/src/vector/platform/ElectronPlatform.tsx` opens `DesktopCapturerSourcePicker`; `apps/web/src/components/views/elements/DesktopCapturerSourcePicker.tsx` selects or cancels.
5. `ElectronPlatform` sends `callDisplayMediaCallback`; `apps/desktop/src/ipc.ts` invokes and clears the single callback held by `apps/desktop/src/displayMediaCallback.ts`. Cancellation supplies an empty dummy video source and `getDisplayMedia()` rejects.
6. LiveKit takes the returned first video and audio tracks, publishes audio as `ScreenShareAudio`, and on explicit unshare unpublishes both. With the default `stopOnUnpublish`, `LocalTrack.stop()` calls the underlying `MediaStreamTrack.stop()`. Publisher destruction also stops/unpublishes tracks; `stopPublishing()` alone intentionally leaves them alive.

The desktop callback store has no request ID, requester identity, replacement protocol, or returned-track-ended notification. A second request can overwrite the singleton callback.

### Process observability

| Owner                              | Can observe today                                                                                                                                           | Cannot directly observe                         |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Element Call / requesting renderer | returned stream/tracks, track `ended`, LiveKit publish/unpublish and room teardown                                                                          | native producer, bridge resources               |
| outer ElectronPlatform renderer    | picker open/select/cancel and call UI                                                                                                                       | Element Call frame's returned track lifetime    |
| preload                            | whitelisted picker control messages                                                                                                                         | returned track lifetime; no stop channel exists |
| Electron main                      | request and requesting frame/WebContents, picker result, navigation/crash/destruction, app/window lifecycle, hidden bridge lifecycle, bridge capturer count | a documented `MediaStreamTrack.stop()` event    |
| hidden bridge renderer             | AudioContext, worklet, PCM port and its own unload                                                                                                          | returned display track object or LiveKit state  |

### Measured stop-signal behavior

Validated with Electron 43.2.0 on Windows on 2026-08-08:

| Scenario                                           | First deterministic desktop signal                         | Result                                                                                                                                |
| -------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| stop all returned tracks                           | bridge `isBeingCaptured`: true, then false                 | teardown after two false polls; 101 ms measured                                                                                       |
| stop only returned audio track, video remains live | bridge `isBeingCaptured`: true, then false                 | same deterministic teardown; video remained live                                                                                      |
| requester navigation                               | requester `did-start-navigation`                           | 25 ms teardown                                                                                                                        |
| requester renderer crash                           | requester `render-process-gone` (`crashed`)                | 25 ms; requester and bridge OS process IDs were distinct                                                                              |
| requester window close                             | requester WebContents `destroyed` precedes window `closed` | 26 ms                                                                                                                                 |
| bridge window close                                | bridge WebContents `destroyed` precedes window `closed`    | 24 ms; returned audio ends                                                                                                            |
| bridge renderer crash                              | bridge `render-process-gone` (`crashed`)                   | 25 ms                                                                                                                                 |
| active second request                              | new handler entry                                          | first owner stopped as `replaced`; first audio ended while video stayed live; second monotonic owner activated                        |
| picker cancel                                      | explicit picker result before preparation                  | callback completed once with dummy rejection; `NotReadableError`; no bridge created                                                   |
| application shutdown                               | actual `before-quit` handler                               | every quit event is prevented while one shared teardown is awaited within one second; resources are asserted closed before `app.exit` |

Every requester callback owned by each lifecycle session is synchronously removed exactly once. The audit uses exact callback identity; total Electron listener counts are retained only as diagnostics, so unrelated Electron-owned listener churn cannot create a false leak result.

Every successful grant observed the bridge capturer count become true. Direct `audioTrack.stop()` caused it to become false even while the diagnostic screen-video track remained live, proving that the count applies to the bridge audio capturer. Do not act on the initial false value: callback completion, a prior true observation, false debounce, and a capture-start deadline are required.

The bridge's `media-started-playing`, `audio-state-changed` (`event.audible`), and `media-paused` observations did not uniquely identify consumer stop, requester teardown, or bridge teardown. PCM acknowledgements continued after direct `track.stop()` until main observed the capturer-count transition and tore the session down. Worklet rendering and producer activity describe bridge health, not whether the returned track is still wanted.

No new renderer/preload stop IPC is required by these measurements. A dedicated one-owner bridge can use `isBeingCaptured()` plus requester, bridge, and application lifecycle events. If a future Electron version fails the capturer-count acceptance matrix, the fallback is a narrow explicit stop IPC; inactivity or silence timeouts are not valid substitutes.

### Prototype controller and state machine

`session-controller.mjs` models:

    Idle -> Selecting -> Preparing -> Active -> Stopping -> Idle

Electron main owns each request from display-handler entry through teardown. Requests receive monotonic IDs and generation tokens. Callback completion is exactly once. Selection cancellation creates no bridge. Preparation begins only after selection, starts the synthetic producer/bridge, and retains the experiment's 120 ms prebuffer before invoking the display callback. The controller owns producer stop, main-side port close, monitoring timer, and hidden-window destruction.

A new request synchronously supersedes the old owner before it prepares or activates the new one. Stale async completion compares both ID and generation, destroys its stale resource, and cannot invoke a callback. Stop is idempotent and safe against synchronous resource-destruction re-entry. Pending callbacks are rejected during teardown. Production should bind requester frame navigation/detachment and WebContents crash/destruction, bridge crash/destruction, and app shutdown to this same stop operation.

The lifecycle harness tests graceful shutdown through `before-quit`. Product paths that call `app.exit()` do not guarantee graceful quit events, so eventual integration must explicitly call the controller shutdown operation before those exits as well.

### Fidelity findings

The current Element Call constraints produced a real destructive downmix, not merely misleading settings. The track reported one channel with echo cancellation enabled, and both splitter outputs contained the same mixture of the independent 733 Hz left and 997 Hz right sources (about 0.095 amplitude for each tone).

- `channelCount: { ideal: 2 }` reported two channels but still returned identical mixed channels while echo cancellation remained enabled.
- `channelCount: { exact: 2 }` was rejected before capture with `TypeError: exact constraints are not supported`.
- Supplying `echoCancellation: false` in the initial display-audio constraints was accepted and reflected. It also preserved distinct stereo: left retained 733 Hz and right retained 997 Hz, each about 0.141 RMS.
- Initial `channelCount: { ideal: 2 }` plus `echoCancellation: false` likewise preserved distinct stereo.
- Applying `{ echoCancellation: false }` after grant failed with `OverconstrainedError: Cannot satisfy constraints` and left AEC enabled and the signal downmixed.

Electron's display grant has no separate channel-count/AEC option; the initial browser constraints control this behavior. The current bridge must not be called production-ready for application audio while it uses the current constraints, because the selected audio is audibly modeled as processed/downmixed microphone-style capture. A real application-audio listening test is still required before changing product constraints: Element Call intentionally omitted AEC false historically to avoid recapturing incoming participant audio. Process-isolated WASAPI changes that echo premise, but that product decision belongs to a later integration stage.

### Local-output mute manual check

Human observation is still pending. Automation cannot prove what physical speakers emit. Record both controls exactly:

1. Use headphones or very low speaker volume and close other audio-producing applications.
2. Run the normal experiment, click **Start capture**, keep the consumer video muted, and listen for ten seconds. With default `enableLocalEcho: false`, the 733 Hz tone should not be audible locally.
3. Stop and close the experiment.
4. Rerun with `--enable-local-echo`, start capture, and listen again. The same tone should now be audible as the positive control.
5. Stop immediately if feedback or volume is uncomfortable. Record default audible/inaudible and positive-control audible/inaudible separately.

Do not claim local-output muting verified unless the default is inaudible and the positive control is audible.

### Eventual product surface and next stage

The smallest likely product changes are a new desktop session-controller module plus `apps/desktop/src/electron-main.ts`. The current callback/picker path also needs request identity, likely touching `apps/desktop/src/displayMediaCallback.ts` and `apps/desktop/src/ipc.ts`; carrying that ID through `ElectronPlatform.tsx` and preload/channel typing may be necessary. A new stop IPC is not currently necessary.

The recommended next stage is a design-only mapping of this controller's producer interface to the native-addon versus helper-process choices, including HAK/packaging and crash isolation. Do not connect real WASAPI until the initial AEC-false/stereo product constraint decision and the local-output mute check have been resolved.

## Final fidelity/capability gate

This stage still uses only the synthetic WebFrameMain bridge. It does not use
global loopback, WASAPI, an addon, or a helper. Human results must not be
recorded as passing until the observer supplies them.

### Physical local-output A/B

Use headphones (preferred) or very low-volume speakers. Keep the consumer
video muted and close unrelated audio applications. From the repository root:

    apps\desktop\node_modules\.bin\electron.cmd apps\desktop\experiments\realtime-pcm-bridge\main.mjs

Click **Start capture**, listen for ten seconds, then stop and close the
harness. This is A: `enableLocalEcho: false`; the bridge tone must be
inaudible at the sender's physical output. Then run:

    apps\desktop\node_modules\.bin\electron.cmd apps\desktop\experiments\realtime-pcm-bridge\main.mjs --enable-local-echo

Repeat the same steps. This is B: `enableLocalEcho: true`; the bridge tone
must be clearly audible as the positive control. Stop immediately if volume
or feedback is uncomfortable. Report all four items: A audible yes/no, B
audible yes/no, headphones or speakers, and any feedback/ducking/processing
anomaly. Passing requires A=no and B=yes.

### Generic constraint seam

`screen-share-audio-constraints.mjs` demonstrates the narrow semantic seam:

    isolatedScreenShareAudio: false
        -> the established ordinary payload, unchanged

    isolatedScreenShareAudio: true
        -> the established payload plus
           echoCancellation: false
           channelCount: { ideal: 2 }

The selector contains no Windows or Electron condition. Exact deep-equality
tests prove ordinary behavior has no `echoCancellation` or `channelCount`
field and isolated mode produces the initial high-fidelity payload. This is
important because applying AEC false after capture has already failed.

The current bundled Element Call 0.22.0 source map shows the construction
path as:

    LocalMember.toggleScreenSharing
        -> ScreenShareCaptureOptions.audio
        -> LiveKit setScreenShareEnabled
        -> createLocalScreenTracks
        -> navigator.mediaDevices.getDisplayMedia

Element Call already has generic URL behavior parameters. Element Web
already centralizes embedded-call URL construction in `Call.generateWidgetUrl`
and tests it. The recommended production seam is therefore a generic Element
Call URL/config capability such as `isolatedScreenShareAudio`, not a Windows
or Electron detail. Element Web's platform abstraction can default it to
false and enable it only when Desktop reports the isolated source as actually
available. The existing Desktop initialization/config channel can eventually
carry that capability; no new stop IPC is needed.

Likely coordinated production work, not implemented by this experiment:

- Element Call: URL-parameter/config typing and parsing, plus
  `LocalMember.toggleScreenSharing` constraint selection and tests.
- Element Web: `BasePlatform` generic capability defaulting false,
  Desktop's availability-backed override, `Call.generateWidgetUrl` and tests,
  then the normal Element Call package update.
- Element Desktop: the already-designed session controller and bridge/native
  availability reporting in a later stage.

Use Element Call's supported separate-checkout `pnpm dev` workflow with
Element Web's `Developer.elementCallUrl` for linked development. Never edit
the installed `node_modules` distribution. This seam will probably require a
small coordinated Element Call change followed by an Element Web/Desktop PR;
it is not safely expressible as a global Element Call behavior change.

### Isolated two-party harness

`--two-party` loads only an operator-supplied hosted `http` or `https`
Element Web URL. URLs with embedded credentials and all non-web schemes are
rejected. The harness never prints the URL, origin, query, fragment, room,
account, token, credentials, or window title. Use a dedicated test profile,
never a normal Element/Element Nightly profile. The harness does not delete
that profile; remove it yourself only after confirming its exact path and
that it contains no needed data.

PowerShell example (substitute your approved test deployment and dedicated
profile path):

    apps\desktop\node_modules\.bin\electron.cmd apps\desktop\experiments\realtime-pcm-bridge\main.mjs --user-data-dir="$env:TEMP\element-pcm-bridge-two-party" --two-party --element-url="https://YOUR-TEST-ELEMENT-WEB/"

The harness keeps `sandbox: true`, `contextIsolation: true`, and
`nodeIntegration: false`. It grants only media permission to that one test
WebContents and denies other permission types. After a frame becomes ready,
test-only main-world instrumentation wraps that frame's actual
`getDisplayMedia()` call. It merges the generic isolated-audio constraints
into the initial request and records only five sanitized audio fields.
Electron main reads the record from the exact requesting `WebFrameMain` and
fails closed unless the payload is an exact match. Wait for
`TWO_PARTY_INSTRUMENTATION_ARMED` before sharing; the terminal must then show
`TWO_PARTY_REQUEST_ACCEPTED`. A rejected request means do not weaken the gate:
reload, wait for arming, and record a reproducible blocker if it persists.

The granted audio is an alternating cue: 733 Hz on the left for 1.5 seconds,
then 997 Hz on the right for 1.5 seconds. `enableLocalEcho` remains false.
Main retains the 120 ms prebuffer, one-owner replacement, requesting-frame
navigation/crash/destruction handling, bridge destruction handling, app quit
handling, and the proven `isBeingCaptured()` true-to-two-false stop signal.
`TWO_PARTY_SESSION_STOPPED` must report zero resources.

Two-account procedure:

1. Disable OS/headphone mono audio. Put account A in this harness and account
   B in a separate client/device; join the same call.
2. Confirm A's microphone reaches B before sharing. Wait for the armed marker,
   then start screen sharing from A and confirm the accepted-payload marker.
3. B confirms screen video/audio arrive and the cue alternates distinctly
   left then right. If B's device cannot establish stereo, report
   `inconclusive`, not pass.
4. Mute A's microphone: B must still hear the cue. Unmute it: B must hear A's
   speech and the cue independently, without cue pumping or ducking.
5. Mute A's microphone again. While A can hear B, have B speak several unique,
   counted phrases. B must hear no delayed copy of those phrases in
   ScreenShareAudio. This proves only the synthetic bridge is returned; it
   does not by itself prove future WASAPI process isolation.
6. Stop sharing. Within one second the terminal must show exactly one stop
   and zero resources. Repeat start/stop three times.

Report: output device and mono setting; remote screen/audio yes/no; stereo
pass/fail/inconclusive; microphone independence yes/no; B self-echo yes/no;
teardown time/zero-resource result for all three cycles; and any audible
pumping, ducking, distortion, or other processing.

Static and fail-closed tests:

    node --test apps/desktop/experiments/realtime-pcm-bridge/*.test.mjs
    node --check apps/desktop/experiments/realtime-pcm-bridge/two-party-main.mjs

The pure tests cover URL rejection, pre-arm rejection, exact sanitized
payload assertion, ordinary-payload compatibility, and the actual initial
request wrapper. Account-dependent media delivery and physical output remain
human observations.
