/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import assert from "node:assert/strict";
import test from "node:test";
import { StereoPcm16Queue } from "./pcm-core.mjs";

function packet(frames, left = 32767, right = -32768) {
    const values = new Int16Array(frames * 2);
    for (let frame = 0; frame < frames; frame += 1) {
        values[frame * 2] = left;
        values[frame * 2 + 1] = right;
    }
    return values.buffer;
}

test("rejects packets that are not complete stereo PCM16 frames", () => {
    const queue = new StereoPcm16Queue(4);
    assert.throws(() => queue.push(new ArrayBuffer(3)), /aligned/);
});

test("converts PCM endpoints and emits silence on underrun", () => {
    const queue = new StereoPcm16Queue(4);
    queue.push(packet(1));
    const left = new Float32Array(2);
    const right = new Float32Array(2);
    assert.equal(queue.pull(left, right), 1);
    assert.equal(left[0], 32767 / 32768);
    assert.equal(right[0], -1);
    assert.equal(left[1], 0);
    assert.equal(queue.underrunFrames, 1);
});

test("drops the oldest complete frames and never exceeds capacity", () => {
    const queue = new StereoPcm16Queue(3);
    queue.push(packet(2, 1000, 1000));
    queue.push(packet(3, 2000, 2000));
    assert.equal(queue.queuedFrames, 3);
    assert.equal(queue.maxQueuedFrames, 3);
    assert.equal(queue.droppedFrames, 2);
    const left = new Float32Array(3);
    queue.pull(left, new Float32Array(3));
    assert.deepEqual([...left], Array(3).fill(2000 / 32768));
});
