/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

export const CHANNELS = 2;
export const SAMPLE_RATE = 48_000;

export class StereoPcm16Queue {
    constructor(capacityFrames) {
        if (!Number.isInteger(capacityFrames) || capacityFrames <= 0)
            throw new RangeError("capacityFrames must be positive");
        this.capacityFrames = capacityFrames;
        this.left = new Float32Array(capacityFrames);
        this.right = new Float32Array(capacityFrames);
        this.readIndex = 0;
        this.queuedFrames = 0;
        this.droppedFrames = 0;
        this.underrunFrames = 0;
        this.maxQueuedFrames = 0;
    }

    push(arrayBuffer) {
        if (
            !(arrayBuffer instanceof ArrayBuffer) ||
            arrayBuffer.byteLength % (CHANNELS * Int16Array.BYTES_PER_ELEMENT) !== 0
        ) {
            throw new RangeError("PCM packet must contain aligned interleaved stereo PCM16 frames");
        }

        const samples = new Int16Array(arrayBuffer);
        let sourceFrame = 0;
        let frameCount = samples.length / CHANNELS;
        if (frameCount > this.capacityFrames) {
            const skipped = frameCount - this.capacityFrames;
            sourceFrame = skipped;
            frameCount = this.capacityFrames;
            this.droppedFrames += skipped;
        }

        const overflow = Math.max(0, this.queuedFrames + frameCount - this.capacityFrames);
        if (overflow > 0) {
            this.readIndex = (this.readIndex + overflow) % this.capacityFrames;
            this.queuedFrames -= overflow;
            this.droppedFrames += overflow;
        }

        let writeIndex = (this.readIndex + this.queuedFrames) % this.capacityFrames;
        for (let frame = 0; frame < frameCount; frame += 1) {
            const sampleIndex = (sourceFrame + frame) * CHANNELS;
            this.left[writeIndex] = samples[sampleIndex] / 32768;
            this.right[writeIndex] = samples[sampleIndex + 1] / 32768;
            writeIndex = (writeIndex + 1) % this.capacityFrames;
        }
        this.queuedFrames += frameCount;
        this.maxQueuedFrames = Math.max(this.maxQueuedFrames, this.queuedFrames);
        return frameCount;
    }

    pull(leftOutput, rightOutput) {
        const requested = leftOutput.length;
        const available = Math.min(requested, this.queuedFrames);
        for (let frame = 0; frame < available; frame += 1) {
            leftOutput[frame] = this.left[this.readIndex];
            rightOutput[frame] = this.right[this.readIndex];
            this.readIndex = (this.readIndex + 1) % this.capacityFrames;
        }
        if (available < requested) {
            leftOutput.fill(0, available);
            rightOutput.fill(0, available);
            this.underrunFrames += requested - available;
        }
        this.queuedFrames -= available;
        return available;
    }
}
