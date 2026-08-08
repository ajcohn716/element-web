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
