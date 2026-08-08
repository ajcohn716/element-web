/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

const status = document.querySelector("#status");

window.addEventListener(
    "message",
    async (event) => {
        if (event.source !== window || event.data?.type !== "pcm-bridge-port" || event.ports.length !== 1) return;
        const inputPort = event.ports[0];
        try {
            const context = new AudioContext({ sampleRate: 48_000, latencyHint: "interactive" });
            if (context.sampleRate !== 48_000)
                throw new Error(`AudioContext sample rate is ${context.sampleRate}, expected 48000`);
            await context.audioWorklet.addModule("./pcm-worklet.js");
            const node = new AudioWorkletNode(context, "pcm-bridge", {
                numberOfInputs: 0,
                numberOfOutputs: 1,
                outputChannelCount: [2],
            });
            node.connect(context.destination);
            node.port.onmessage = (workletEvent) => {
                if (workletEvent.data?.type === "stats") {
                    window.bridgeHost.report(workletEvent.data);
                } else if (workletEvent.data?.type === "port-attached") {
                    window.bridgeHost.ready({ sampleRate: context.sampleRate, contextState: context.state });
                }
            };
            await context.resume();
            node.port.postMessage({ type: "attach-port" }, [inputPort]);
            status.textContent = `AudioContext ${context.state} at ${context.sampleRate} Hz`;
            window.addEventListener("beforeunload", () => {
                node.disconnect();
                void context.close();
            });
        } catch (error) {
            status.textContent = String(error);
            window.bridgeHost.failed(String(error));
        }
    },
    { once: true },
);
window.bridgeHost.requestPort();
