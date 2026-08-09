/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

const startButton = document.querySelector("#start");
const stopButton = document.querySelector("#stop");
const cycleButton = document.querySelector("#cycle");
const video = document.querySelector("#video");
const result = document.querySelector("#result");
const stats = document.querySelector("#stats");
let stream;
let analysisContext;
let latestStats;
let latestBridgeDetails;

const DISPLAY_AUDIO_CONSTRAINTS = {
    autoGainControl: false,
    noiseSuppression: false,
    voiceIsolation: false,
};

function assert(condition, message) {
    if (!condition) throw new Error(`Acceptance assertion failed: ${message}`);
}

function magnitude(samples, sampleRate, frequency) {
    let real = 0;
    let imaginary = 0;
    for (let index = 0; index < samples.length; index += 1) {
        const angle = (2 * Math.PI * frequency * index) / sampleRate;
        real += samples[index] * Math.cos(angle);
        imaginary -= samples[index] * Math.sin(angle);
    }
    return (2 * Math.hypot(real, imaginary)) / samples.length;
}

async function analyze(track) {
    analysisContext = new AudioContext({ sampleRate: 48_000 });
    const source = analysisContext.createMediaStreamSource(new MediaStream([track]));
    const analyser = analysisContext.createAnalyser();
    analyser.fftSize = 32768;
    source.connect(analyser);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const samples = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(samples);
    const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
    const tone733 = magnitude(samples, analysisContext.sampleRate, 733);
    const tone997 = magnitude(samples, analysisContext.sampleRate, 997);
    const separationDb = 20 * Math.log10(Math.max(tone733, 1e-9) / Math.max(tone997, 1e-9));
    return { sampleRate: analysisContext.sampleRate, rms, tone733, tone997, separationDb };
}

async function analyzeChannels(track) {
    const context = new AudioContext({ sampleRate: 48_000 });
    const source = context.createMediaStreamSource(new MediaStream([track]));
    const splitter = context.createChannelSplitter(2);
    const left = context.createAnalyser();
    const right = context.createAnalyser();
    left.fftSize = 32768;
    right.fftSize = 32768;
    source.connect(splitter);
    splitter.connect(left, 0);
    splitter.connect(right, 1);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const leftSamples = new Float32Array(left.fftSize);
    const rightSamples = new Float32Array(right.fftSize);
    left.getFloatTimeDomainData(leftSamples);
    right.getFloatTimeDomainData(rightSamples);
    const metrics = (samples) => ({
        rms: Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length),
        tone733: magnitude(samples, context.sampleRate, 733),
        tone997: magnitude(samples, context.sampleRate, 997),
    });
    const value = { sampleRate: context.sampleRate, left: metrics(leftSamples), right: metrics(rightSamples) };
    await context.close();
    return value;
}

async function fidelityCase(name, audioConstraints, applyConstraints) {
    latestBridgeDetails = undefined;
    const fidelityStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: audioConstraints });
    const track = fidelityStream.getAudioTracks()[0];
    const before = {
        settings: track.getSettings(),
        constraints: track.getConstraints(),
        capabilities: track.getCapabilities(),
    };
    let application;
    if (applyConstraints) {
        try {
            await track.applyConstraints(applyConstraints);
            application = { ok: true };
        } catch (error) {
            application = { ok: false, error: `${error.name}: ${error.message}` };
        }
    }
    const after = {
        settings: track.getSettings(),
        constraints: track.getConstraints(),
        capabilities: track.getCapabilities(),
    };
    const channels = await analyzeChannels(track);
    fidelityStream.getTracks().forEach((item) => item.stop());
    await window.diagnostics.stopSession();
    return { name, bridge: latestBridgeDetails, before, application, after, channels };
}

async function start() {
    if (stream) return;
    result.textContent = "Requesting display media...";
    latestBridgeDetails = undefined;
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: DISPLAY_AUDIO_CONSTRAINTS });
    const audioTracks = stream.getAudioTracks();
    const videoTracks = stream.getVideoTracks();
    if (audioTracks.length !== 1 || videoTracks.length !== 1) {
        throw new Error(
            `Expected one audio and one video track; received ${audioTracks.length} audio, ${videoTracks.length} video`,
        );
    }
    video.srcObject = stream;
    startButton.disabled = true;
    stopButton.disabled = false;
    const metrics = await analyze(audioTracks[0]);
    result.textContent = JSON.stringify(
        {
            security: window.diagnostics.runtime,
            bridge: latestBridgeDetails,
            nodeIntegrationVisibleInPage: typeof globalThis.require !== "undefined",
            audioTrack: { label: audioTracks[0].label, settings: audioTracks[0].getSettings() },
            videoTrackCount: videoTracks.length,
            metrics,
            passesToneSeparation: metrics.rms > 0.001 && metrics.separationDb >= 20,
        },
        null,
        2,
    );
}

async function stop() {
    stream?.getTracks().forEach((track) => track.stop());
    stream = undefined;
    video.srcObject = null;
    await analysisContext?.close();
    analysisContext = undefined;
    await window.diagnostics.stopSession();
    startButton.disabled = false;
    stopButton.disabled = true;
}

startButton.addEventListener("click", () =>
    start().catch((error) => {
        result.textContent = String(error.stack ?? error);
        void stop();
    }),
);
stopButton.addEventListener("click", () => void stop());
cycleButton.addEventListener("click", async () => {
    cycleButton.disabled = true;
    try {
        for (let cycle = 1; cycle <= 10; cycle += 1) {
            await start();
            result.textContent = `Cycle ${cycle}/10 completed analysis`;
            await stop();
        }
        result.textContent = "10 start/stop cycles completed";
    } catch (error) {
        result.textContent = String(error.stack ?? error);
        await stop();
    } finally {
        cycleButton.disabled = false;
    }
});
window.diagnostics.onStats((value) => {
    latestStats = value;
    stats.textContent = JSON.stringify(value, null, 2);
});
window.diagnostics.onBridgeReady((value) => {
    latestBridgeDetails = value;
});
window.runtimeTest = {
    async runFidelity() {
        const current = { autoGainControl: false, noiseSuppression: false, voiceIsolation: false };
        const cases = [];
        cases.push(await fidelityCase("current Element Call constraints", current));
        cases.push(await fidelityCase("initial channelCount ideal 2", { ...current, channelCount: { ideal: 2 } }));
        let exactStereo;
        try {
            exactStereo = await fidelityCase("initial channelCount exact 2", {
                ...current,
                channelCount: { exact: 2 },
            });
        } catch (error) {
            await window.diagnostics.stopSession();
            exactStereo = { name: "initial channelCount exact 2", captureError: `${error.name}: ${error.message}` };
        }
        cases.push(exactStereo);
        cases.push(await fidelityCase("initial echoCancellation false", { ...current, echoCancellation: false }));
        cases.push(await fidelityCase("apply echoCancellation false", current, { echoCancellation: false }));
        cases.push(
            await fidelityCase("combined stereo and echoCancellation false", {
                ...current,
                channelCount: { ideal: 2 },
                echoCancellation: false,
            }),
        );
        const [baseline, idealStereo, rejectedExactStereo, initialAecOff, appliedAecOff, combined] = cases;
        const mixed = (item) =>
            item.channels.left.tone733 > 0.02 &&
            item.channels.left.tone997 > 0.02 &&
            Math.abs(item.channels.left.rms - item.channels.right.rms) < 0.01 &&
            Math.abs(item.channels.left.tone733 - item.channels.right.tone733) < 0.01 &&
            Math.abs(item.channels.left.tone997 - item.channels.right.tone997) < 0.01;
        const separated = (item) =>
            item.channels.left.rms > 0.05 &&
            item.channels.right.rms > 0.05 &&
            item.channels.left.tone733 / Math.max(item.channels.left.tone997, 1e-6) >= 10 &&
            item.channels.right.tone997 / Math.max(item.channels.right.tone733, 1e-6) >= 10;
        assert(baseline.before.settings.channelCount === 1, "baseline reports mono");
        assert(baseline.before.settings.echoCancellation === true, "baseline reports AEC enabled");
        assert(mixed(baseline), "baseline destructively mixes distinct source channels");
        assert(idealStereo.before.settings.channelCount === 2, "ideal stereo reports two channels");
        assert(idealStereo.before.settings.echoCancellation === true, "ideal stereo leaves AEC enabled");
        assert(mixed(idealStereo), "ideal stereo remains mixed while AEC is enabled");
        assert(rejectedExactStereo.captureError?.startsWith("TypeError:"), "exact stereo is rejected");
        assert(initialAecOff.before.settings.echoCancellation === false, "initial AEC false is reflected");
        assert(initialAecOff.before.settings.channelCount === 2, "initial AEC false reports stereo");
        assert(separated(initialAecOff), "initial AEC false preserves distinct stereo");
        assert(appliedAecOff.application?.ok === false, "post-grant AEC false is rejected");
        assert(appliedAecOff.application.error.startsWith("OverconstrainedError:"), "post-grant AEC error type");
        assert(appliedAecOff.after.settings.echoCancellation === true, "rejected AEC application leaves AEC enabled");
        assert(appliedAecOff.after.settings.channelCount === 1, "rejected AEC application leaves mono setting");
        assert(mixed(appliedAecOff), "rejected AEC application leaves mixed audio");
        assert(combined.before.settings.echoCancellation === false, "combined constraints disable AEC initially");
        assert(combined.before.settings.channelCount === 2, "combined constraints report stereo");
        assert(separated(combined), "combined constraints preserve distinct stereo");
        const diagnostics = await window.diagnostics.sessionDiagnostics();
        assert(!diagnostics.activeSession && diagnostics.bridgeWindows === 0, "fidelity teardown");
        return { cases, diagnostics };
    },
    async run(soakMilliseconds) {
        const cycles = [];
        for (let cycle = 1; cycle <= 10; cycle += 1) {
            await start();
            cycles.push(JSON.parse(result.textContent));
            await stop();
        }
        const afterCycles = await window.diagnostics.sessionDiagnostics();
        for (const [index, cycle] of cycles.entries()) {
            assert(cycle.passesToneSeparation && cycle.metrics.rms > 0.001, `cycle ${index + 1} tone/RMS`);
            assert(cycle.metrics.sampleRate === 48_000, `cycle ${index + 1} analysis sample rate`);
            assert(
                cycle.bridge?.sampleRate === 48_000 && cycle.bridge.contextState === "running",
                `cycle ${index + 1} bridge rate/state`,
            );
            assert(cycle.security.sandboxed === true, `cycle ${index + 1} sandbox`);
            assert(cycle.security.contextIsolated === true, `cycle ${index + 1} context isolation`);
            assert(cycle.nodeIntegrationVisibleInPage === false, `cycle ${index + 1} Node visibility`);
        }
        assert(!afterCycles.activeSession && afterCycles.bridgeWindows === 0, "cycle teardown");
        await start();
        const analysis = JSON.parse(result.textContent);
        await new Promise((resolve) => setTimeout(resolve, soakMilliseconds));
        const soakStats = latestStats;
        const soakUnderrunFraction = soakStats.underrunFrames / soakStats.renderedFrames;
        const soakDropFraction = soakStats.droppedFrames / soakStats.receivedFrames;
        assert(analysis.passesToneSeparation && analysis.metrics.rms > 0.001, "soak tone/RMS");
        assert(analysis.metrics.sampleRate === 48_000, "soak analysis rate");
        assert(
            analysis.bridge?.sampleRate === 48_000 && analysis.bridge.contextState === "running",
            "soak bridge rate/state",
        );
        assert(soakStats.maxQueuedFrames <= soakStats.capacityFrames, "queue capacity");
        assert((soakStats.queuedFrames / 48_000) * 1000 < 250, "queued latency");
        assert(soakUnderrunFraction < 0.01, "soak underrun rate");
        assert(soakDropFraction < 0.01, "soak drop rate");
        assert(soakStats.discontinuities === 0, "soak discontinuities");
        await window.diagnostics.exerciseProducer();
        await new Promise((resolve) => setTimeout(resolve, 1200));
        const stressStats = latestStats;
        assert(stressStats.underrunFrames > soakStats.underrunFrames, "pause adds underruns");
        assert(stressStats.droppedFrames > soakStats.droppedFrames, "burst adds drops");
        assert(stressStats.maxQueuedFrames <= stressStats.capacityFrames, "stress queue capacity");
        await stop();
        await start();
        await window.diagnostics.destroyBridge();
        await new Promise((resolve) => setTimeout(resolve, 250));
        const trackStatesAfterBridgeDestroy = stream
            .getTracks()
            .map((track) => ({ kind: track.kind, readyState: track.readyState }));
        assert(
            trackStatesAfterBridgeDestroy.some((track) => track.kind === "audio" && track.readyState === "ended"),
            "bridge destruction ends audio",
        );
        assert(
            trackStatesAfterBridgeDestroy.some((track) => track.kind === "video" && track.readyState === "live"),
            "bridge destruction preserves diagnostic video",
        );
        await stop();
        await window.diagnostics.cancelNextRequest();
        let preCallbackCancellation;
        try {
            await navigator.mediaDevices.getDisplayMedia({ video: true, audio: DISPLAY_AUDIO_CONSTRAINTS });
            preCallbackCancellation = "unexpectedly resolved";
        } catch (error) {
            preCallbackCancellation = `${error.name}: ${error.message}`;
        }
        const finalSessionDiagnostics = await window.diagnostics.sessionDiagnostics();
        assert(preCallbackCancellation.startsWith("NotReadableError:"), "pre-callback cancellation error");
        assert(!finalSessionDiagnostics.activeSession && finalSessionDiagnostics.bridgeWindows === 0, "final teardown");
        return {
            cycles,
            afterCycles,
            analysis,
            soakStats,
            stressStats,
            trackStatesAfterBridgeDestroy,
            preCallbackCancellation,
            finalSessionDiagnostics,
        };
    },
};
