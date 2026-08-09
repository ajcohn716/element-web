/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { SAMPLE_RATE, StereoPcm16Queue } from "./pcm-core.mjs";

const CAPACITY_FRAMES = Math.round(SAMPLE_RATE * 0.2);

class PcmBridgeProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.queue = new StereoPcm16Queue(CAPACITY_FRAMES);
        this.inputPort = null;
        this.expectedSequence = 0;
        this.expectedStartFrame = 0;
        this.receivedFrames = 0;
        this.renderedFrames = 0;
        this.discontinuities = 0;
        this.lastReportFrame = 0;
        this.port.onmessage = (event) => {
            if (event.data?.type === "r2-close-input-port") {
                this.inputPort?.close();
                this.inputPort = null;
                return;
            }
            if (event.data?.type !== "attach-port" || event.ports.length !== 1 || this.inputPort) return;
            this.inputPort = event.ports[0];
            this.inputPort.onmessage = (packetEvent) => this.receivePacket(packetEvent.data);
            this.inputPort.start();
            this.port.postMessage({ type: "port-attached" });
        };
    }

    receivePacket(packet) {
        if (packet?.type === "stop") {
            this.inputPort?.close();
            this.inputPort = null;
            return;
        }
        if (
            packet?.type !== "pcm" ||
            !Number.isSafeInteger(packet.sequence) ||
            !Number.isSafeInteger(packet.startFrame) ||
            !(packet.pcm instanceof ArrayBuffer)
        ) {
            this.discontinuities += 1;
            return;
        }
        if (packet.sequence !== this.expectedSequence || packet.startFrame !== this.expectedStartFrame) {
            this.discontinuities += 1;
        }
        const packetFrames = packet.pcm.byteLength / 4;
        this.expectedSequence = packet.sequence + 1;
        this.expectedStartFrame = packet.startFrame + packetFrames;
        try {
            this.receivedFrames += this.queue.push(packet.pcm);
        } catch {
            this.discontinuities += 1;
        }
        this.inputPort?.postMessage({ type: "ack", sequence: packet.sequence });
    }

    process(_inputs, outputs) {
        const output = outputs[0];
        if (!output?.[0]) return true;
        const left = output[0];
        const right = output[1] ?? output[0];
        this.queue.pull(left, right);
        this.renderedFrames += left.length;

        if (this.renderedFrames - this.lastReportFrame >= SAMPLE_RATE) {
            this.lastReportFrame = this.renderedFrames;
            this.port.postMessage({
                type: "stats",
                receivedFrames: this.receivedFrames,
                renderedFrames: this.renderedFrames,
                underrunFrames: this.queue.underrunFrames,
                droppedFrames: this.queue.droppedFrames,
                discontinuities: this.discontinuities,
                queuedFrames: this.queue.queuedFrames,
                maxQueuedFrames: this.queue.maxQueuedFrames,
                capacityFrames: this.queue.capacityFrames,
            });
        }
        return true;
    }
}

registerProcessor("pcm-bridge", PcmBridgeProcessor);
