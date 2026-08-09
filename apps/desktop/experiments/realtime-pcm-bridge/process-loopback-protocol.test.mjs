/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import assert from "node:assert/strict";
import test from "node:test";
import {
    MAX_PROTOCOL_BUFFER_BYTES,
    PROCESS_LOOPBACK_HEADER_BYTES,
    PROCESS_LOOPBACK_MAGIC,
    ProcessLoopbackProtocolParser,
} from "./process-loopback-protocol.mjs";

function packet(
    type,
    payload = Buffer.alloc(0),
    { sequence = 0, startFrame = 0, flags = 0, reason = 0, counter = 0 } = {},
) {
    const result = Buffer.alloc(PROCESS_LOOPBACK_HEADER_BYTES + payload.length);
    result.writeUInt32LE(PROCESS_LOOPBACK_MAGIC, 0);
    result.writeUInt16LE(1, 4);
    result.writeUInt16LE(type, 6);
    result.writeUInt32LE(PROCESS_LOOPBACK_HEADER_BYTES, 8);
    result.writeUInt32LE(payload.length, 12);
    result.writeBigUInt64LE(BigInt(sequence), 16);
    result.writeBigUInt64LE(BigInt(startFrame), 24);
    result.writeUInt32LE(flags, 32);
    result.writeUInt32LE(reason, 36);
    result.writeBigUInt64LE(BigInt(counter), 40);
    payload.copy(result, PROCESS_LOOPBACK_HEADER_BYTES);
    return result;
}

function start() {
    const payload = Buffer.alloc(16);
    payload.writeUInt32LE(48_000, 0);
    payload.writeUInt16LE(2, 4);
    payload.writeUInt16LE(16, 6);
    payload.writeUInt16LE(4, 8);
    payload.writeUInt32LE(192_000, 12);
    return packet(1, payload);
}

test("parses arbitrary fragmentation and coalescing", () => {
    const packets = [];
    const errors = [];
    const bytes = Buffer.concat([
        start(),
        packet(2, Buffer.alloc(1_920), { sequence: 0, startFrame: 0 }),
        packet(3, Buffer.alloc(0), { sequence: 1, startFrame: 480 }),
    ]);
    const parser = new ProcessLoopbackProtocolParser({
        onPacket: (value) => packets.push(value),
        onError: (e) => errors.push(e),
    });
    for (let offset = 0; offset < bytes.length; offset += 7) parser.push(bytes.subarray(offset, offset + 7));
    parser.finish();
    assert.deepEqual(
        packets.map((value) => value.type),
        [1, 2, 3],
    );
    assert.equal(packets[1].payload.length, 1_920);
    assert.equal(errors.length, 0);
});

test("rejects malformed headers, oversized payloads, and truncated EOF", () => {
    for (const bytes of [
        Buffer.alloc(48),
        (() => {
            const value = start();
            value.writeUInt32LE(192_001, 12);
            return value;
        })(),
        start().subarray(0, 17),
    ]) {
        const errors = [];
        const parser = new ProcessLoopbackProtocolParser({ onError: (error) => errors.push(error) });
        parser.push(bytes);
        parser.finish();
        assert.equal(errors.length, 1);
    }
});

test("rejects PCM before START and unaligned PCM", () => {
    for (const bytes of [packet(2, Buffer.alloc(4)), Buffer.concat([start(), packet(2, Buffer.alloc(3))])]) {
        const errors = [];
        const parser = new ProcessLoopbackProtocolParser({ onError: (error) => errors.push(error) });
        parser.push(bytes);
        assert.equal(errors.length, 1);
    }
});

test("rejects duplicate START, non-contiguous PCM, END ordering, and trailing bytes", () => {
    for (const bytes of [
        Buffer.concat([start(), start()]),
        Buffer.concat([start(), packet(2, Buffer.alloc(4), { sequence: 1 })]),
        Buffer.concat([
            start(),
            packet(2, Buffer.alloc(4)),
            packet(3, Buffer.alloc(0), { sequence: 1, startFrame: 2 }),
        ]),
        Buffer.concat([start(), packet(3), Buffer.from([1])]),
    ]) {
        const errors = [];
        const parser = new ProcessLoopbackProtocolParser({ onError: (error) => errors.push(error) });
        parser.push(bytes);
        parser.finish();
        assert.equal(errors.length, 1);
    }
});

test("enforces parser caps and JavaScript-safe counters", () => {
    const oversizedBuffered = Buffer.alloc(MAX_PROTOCOL_BUFFER_BYTES + 1);
    const unsafeCounter = start();
    unsafeCounter.writeBigUInt64LE(BigInt(Number.MAX_SAFE_INTEGER) + 1n, 40);
    for (const bytes of [oversizedBuffered, unsafeCounter]) {
        const errors = [];
        const parser = new ProcessLoopbackProtocolParser({ onError: (error) => errors.push(error) });
        parser.push(bytes);
        assert.equal(errors.length, 1);
    }
});
