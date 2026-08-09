/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

const constraints = {
    video: true,
    audio: {
        autoGainControl: false,
        noiseSuppression: false,
        voiceIsolation: false,
        echoCancellation: false,
        channelCount: { ideal: 2 },
    },
};

async function capture() {
    return navigator.mediaDevices.getDisplayMedia(constraints);
}

let heldCapture;

window.startR2Capture = async () => {
    try {
        heldCapture = await capture();
        return { result: "granted", tracks: heldCapture.getTracks().length };
    } catch (error) {
        return { result: "rejected", name: error.name };
    }
};

window.stopHeldCaptureAfterObservation = async () => {
    if (!heldCapture) throw new Error("no held R2 capture");
    await window.r2Host.command("wait-capture-observed");
    const statesBeforeStop = {
        audio: heldCapture.getAudioTracks()[0].readyState,
        video: heldCapture.getVideoTracks()[0].readyState,
    };
    heldCapture.getTracks().forEach((track) => track.stop());
    return statesBeforeStop;
};

window.waitForHeldCaptureObservation = async () => {
    if (!heldCapture) throw new Error("no held R2 capture");
    await window.r2Host.command("wait-capture-observed");
    return {
        audio: heldCapture.getAudioTracks()[0].readyState,
        video: heldCapture.getVideoTracks()[0].readyState,
    };
};

window.stopHeldCapture = () => {
    if (!heldCapture) throw new Error("no held R2 capture");
    heldCapture.getTracks().forEach((track) => track.stop());
};

async function waitFor(predicate, label, timeout = 1_500) {
    const started = performance.now();
    while (!predicate()) {
        if (performance.now() - started > timeout) throw new Error(`timed out waiting for ${label}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

window.runR2Case = async (caseName) => {
    if (
        [
            "malformed-source",
            "stale-hwnd",
            "dead-pid",
            "missing-exe",
            "exit-before-start",
            "init-reject",
            "unsupported-simulated",
            "missing-worklet",
            "picker-cancel",
            "cancel-startup",
            "cancel-prebuffer",
        ].includes(caseName)
    ) {
        let stream;
        try {
            stream = await capture();
        } catch (error) {
            return { rejected: true, name: error.name };
        }
        stream.getTracks().forEach((track) => track.stop());
        throw new Error(`${caseName} unexpectedly returned a stream`);
    }
    if (["replace-preparing", "stale-preparation"].includes(caseName)) {
        const first = capture().catch((error) => ({ rejected: error.name }));
        await new Promise((resolve) => setTimeout(resolve, 30));
        const second = await capture();
        if (caseName === "replace-preparing") await window.r2Host.command("wait-capture-observed");
        const firstResult = await first;
        second.getTracks().forEach((track) => track.stop());
        return { firstRejected: Boolean(firstResult.rejected), secondTracks: second.getTracks().length };
    }
    const first = await capture();
    if (caseName === "replace-active") {
        const second = await capture();
        await window.r2Host.command("wait-capture-observed");
        await waitFor(() => first.getAudioTracks()[0].readyState === "ended", "replaced audio track to end");
        const statesAfterReplacement = {
            firstAudio: first.getAudioTracks()[0].readyState,
            firstVideo: first.getVideoTracks()[0].readyState,
            secondAudio: second.getAudioTracks()[0].readyState,
            secondVideo: second.getVideoTracks()[0].readyState,
        };
        second.getTracks().forEach((track) => track.stop());
        first.getTracks().forEach((track) => track.stop());
        return {
            firstTracks: first.getTracks().length,
            secondTracks: second.getTracks().length,
            statesAfterReplacement,
        };
    }
    if (caseName === "audio-track-stop") {
        first.getAudioTracks()[0].stop();
        return {
            audioState: first.getAudioTracks()[0].readyState,
            videoState: first.getVideoTracks()[0].readyState,
        };
    } else if (caseName === "all-tracks-stop") {
        first.getTracks().forEach((track) => track.stop());
        return {
            audioState: first.getAudioTracks()[0].readyState,
            videoState: first.getVideoTracks()[0].readyState,
        };
    } else if (caseName === "requester-navigate") await window.r2Host.command("requester-navigate");
    else if (caseName === "requester-close") await window.r2Host.command("requester-close");
    else if (caseName === "requester-crash") await window.r2Host.command("requester-crash");
    else if (caseName === "native-success") {
        await window.r2Host.command("wait-capture-observed");
        first.getTracks().forEach((track) => track.stop());
    } else if (caseName === "bridge-destroy") await window.r2Host.command("bridge-destroy");
    else if (caseName === "bridge-crash") await window.r2Host.command("bridge-crash");
    else if (caseName === "app-quit" || caseName === "explicit-shutdown") await window.r2Host.command(caseName);
    else if (
        ![
            "crash-active",
            "stdout-close",
            "truncated",
            "malformed",
            "stall",
            "close-port",
            "native-target-exit",
            "adapter-burst",
            "queue-overflow",
        ].includes(caseName)
    )
        first.getTracks().forEach((track) => track.stop());
    return { tracks: first.getTracks().length };
};
