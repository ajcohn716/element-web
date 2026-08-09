/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { PROCESS_LOOPBACK_HEADER_BYTES, PROCESS_LOOPBACK_MAGIC } from "./process-loopback-protocol.mjs";
import { ProcessLoopbackAdapter } from "./process-loopback-adapter.mjs";

function framed(type, payload = Buffer.alloc(0), sequence = 0, startFrame = 0) {
    const result = Buffer.alloc(PROCESS_LOOPBACK_HEADER_BYTES + payload.length);
    result.writeUInt32LE(PROCESS_LOOPBACK_MAGIC, 0);
    result.writeUInt16LE(1, 4);
    result.writeUInt16LE(type, 6);
    result.writeUInt32LE(PROCESS_LOOPBACK_HEADER_BYTES, 8);
    result.writeUInt32LE(payload.length, 12);
    result.writeBigUInt64LE(BigInt(sequence), 16);
    result.writeBigUInt64LE(BigInt(startFrame), 24);
    payload.copy(result, PROCESS_LOOPBACK_HEADER_BYTES);
    return result;
}

function startPacket() {
    const payload = Buffer.alloc(16);
    payload.writeUInt32LE(48_000, 0);
    payload.writeUInt16LE(2, 4);
    payload.writeUInt16LE(16, 6);
    payload.writeUInt16LE(4, 8);
    payload.writeUInt32LE(192_000, 12);
    return framed(1, payload);
}

function harness(maxInFlight = 2) {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stderr.setEncoding = () => {};
    child.stdin = {
        end: (value) => {
            child.stopInput = value;
        },
    };
    child.exitCode = null;
    child.signalCode = null;
    child.kill = () => {
        child.killed = true;
    };
    const port = new EventEmitter();
    port.start = () => {};
    port.close = () => {
        port.closed = true;
    };
    port.postMessage = (value) => {
        (port.sent ??= []).push(value);
    };
    let spawnArguments;
    const adapter = new ProcessLoopbackAdapter({
        executable: "unused",
        pid: 42,
        mode: "include",
        port,
        maxInFlight,
        spawnProcess: (...args) => {
            spawnArguments = args;
            return child;
        },
    });
    return { adapter, child, port, spawnArguments };
}

test("forwards under the in-flight cap and drops complete newest packets", () => {
    const { adapter, child, port } = harness(1);
    child.stdout.emit(
        "data",
        Buffer.concat([startPacket(), framed(2, Buffer.alloc(16), 0, 0), framed(2, Buffer.alloc(16), 1, 4)]),
    );
    assert.equal(port.sent.length, 1);
    assert.deepEqual(adapter.stats, {
        receivedPackets: 2,
        forwardedPackets: 1,
        droppedPackets: 1,
        droppedFrames: 4,
        inFlight: 1,
        protocolDiscontinuities: 0,
    });
    port.emit("message", { data: { type: "ack", sequence: 0 } });
    child.stdout.emit("data", framed(2, Buffer.alloc(16), 2, 8));
    assert.equal(port.sent[1].sequence, 2);
    assert.equal(port.sent[1].startFrame, 8);
});

test("spawns a hidden producer with the exact stream contract and rejects unsafe ACKs", () => {
    const { adapter, child, port, spawnArguments } = harness();
    assert.deepEqual(spawnArguments[1], ["stream", "42", "include"]);
    assert.deepEqual(spawnArguments[2], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    child.stdout.emit("data", Buffer.concat([startPacket(), framed(2, Buffer.alloc(16), 0, 0)]));
    port.emit("message", { data: { type: "ack", sequence: 99 } });
    assert.equal(adapter.stats.inFlight, 1);
    assert.equal(adapter.stats.protocolDiscontinuities, 1);
});

test("clean END is terminal and premature EOF is rejected", () => {
    const cleanTerminals = [];
    const clean = harness();
    clean.adapter.onTerminal = (value) => cleanTerminals.push(value);
    clean.child.stdout.emit("data", Buffer.concat([startPacket(), framed(3)]));
    assert.equal(cleanTerminals.length, 0);
    clean.child.stdout.emit("end");
    assert.equal(cleanTerminals[0].reason, "producer-ended");

    const prematureTerminals = [];
    const premature = harness();
    premature.adapter.onTerminal = (value) => prematureTerminals.push(value);
    premature.child.stdout.emit("data", startPacket());
    premature.child.stdout.emit("end");
    assert.equal(prematureTerminals[0].reason, "malformed-producer-stream");
});

test("trailing producer bytes after END fail through the adapter immediately", () => {
    const terminals = [];
    const { adapter, child } = harness();
    adapter.onTerminal = (value) => terminals.push(value);
    child.stdout.emit("data", Buffer.concat([startPacket(), framed(3), Buffer.from([0x7f])]));
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0].reason, "malformed-producer-stream");
    assert.equal(child.stopInput, "STOP\n");
});

test("stop is idempotent and sends STOP before bounded reap", async () => {
    const { adapter, child, port } = harness();
    const first = adapter.stop("test");
    assert.equal(adapter.stop("again"), first);
    assert.equal(child.stopInput, "STOP\n");
    child.exitCode = 0;
    child.emit("exit", 0, null);
    await first;
    assert.equal(port.closed, true);
});

test("malformed producer data is terminal", () => {
    const { child } = harness();
    // A malformed stream is observed and drained without creating PCM backlog.
    child.stdout.emit("data", Buffer.alloc(48));
    child.stdout.emit("data", Buffer.alloc(1024));
    assert.equal(child.stopInput, "STOP\n");
});
