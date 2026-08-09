/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

function magnitude(samples, sampleRate, frequency) {
    let sin = 0;
    let cos = 0;
    for (let index = 0; index < samples.length; index += 1) {
        const phase = (2 * Math.PI * frequency * index) / sampleRate;
        sin += samples[index] * Math.sin(phase);
        cos += samples[index] * Math.cos(phase);
    }
    return (2 * Math.hypot(sin, cos)) / samples.length;
}

async function analyze(stream) {
    const context = new AudioContext({ sampleRate: 48_000 });
    await context.resume();
    if (context.state !== "running") throw new Error(`analysis AudioContext is ${context.state}`);
    const source = context.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
    const splitter = context.createChannelSplitter(2);
    const processors = [context.createScriptProcessor(4096, 1, 1), context.createScriptProcessor(4096, 1, 1)];
    const captured = [[], []];
    source.connect(splitter);
    processors.forEach((processor, channel) => {
        splitter.connect(processor, channel);
        processor.connect(context.destination);
        processor.onaudioprocess = (event) =>
            captured[channel].push(new Float32Array(event.inputBuffer.getChannelData(0)));
    });
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    processors.forEach((processor) => processor.disconnect());
    source.disconnect();
    await context.close();
    const channels = captured.map((chunks) => {
        const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
        const samples = new Float32Array(length);
        let offset = 0;
        for (const chunk of chunks) {
            samples.set(chunk, offset);
            offset += chunk.length;
        }
        return {
            tone733: magnitude(samples, 48_000, 733),
            tone997: magnitude(samples, 48_000, 997),
            unrelated1319: magnitude(samples, 48_000, 1319),
            element1553: magnitude(samples, 48_000, 1553),
        };
    });
    return { channels, contextState: "running", sampleRate: context.sampleRate };
}

async function capture() {
    const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: {
            autoGainControl: false,
            noiseSuppression: false,
            voiceIsolation: false,
            echoCancellation: false,
            channelCount: { ideal: 2 },
        },
    });
    const audioTrack = stream.getAudioTracks()[0];
    if (!audioTrack) throw new Error("display capture returned no audio track");
    const settings = audioTrack.getSettings();
    const analysis = await analyze(stream);
    const beforeStop = await window.realProducerHost.diagnostics();
    const stoppedAt = performance.now();
    stream.getTracks().forEach((track) => track.stop());
    let afterStop;
    do {
        await new Promise((resolve) => setTimeout(resolve, 25));
        afterStop = await window.realProducerHost.diagnostics();
    } while (afterStop.state !== "Idle" && performance.now() - stoppedAt < 1_000);
    return {
        ...analysis,
        settings,
        beforeStop,
        afterStop,
        teardownMilliseconds: performance.now() - stoppedAt,
    };
}

window.runRealProducerGate = async () => {
    const context = new AudioContext({ sampleRate: 48_000 });
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = 1553;
    gain.gain.value = 0.12;
    oscillator.connect(gain).connect(context.destination);
    oscillator.start();
    try {
        await context.resume();
        if (context.state !== "running") throw new Error(`Element tone AudioContext is ${context.state}`);
        const include = await capture();
        const exclude = await capture();
        return { include, exclude, elementContextState: context.state };
    } finally {
        oscillator.stop();
        await context.close();
    }
};
