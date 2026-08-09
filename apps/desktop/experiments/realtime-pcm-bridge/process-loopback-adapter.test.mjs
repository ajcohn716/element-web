/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import assert from "node:assert/strict";
import { spawn as spawnChild } from "node:child_process";
import { EventEmitter, once } from "node:events";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
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

function harness(maxInFlight = 2, options = {}) {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stderr.setEncoding = () => {};
    child.stdin = new EventEmitter();
    child.stdin.destroyed = false;
    child.stdin.end = (value) => {
        child.stopInput = value;
    };
    child.exitCode = null;
    child.signalCode = null;
    child.kill = () => {
        child.killed = true;
    };
    const port = new EventEmitter();
    port.start = () => {
        port.startCount = (port.startCount ?? 0) + 1;
    };
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
        ...options,
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
        inFlightFrames: 4,
        abandonedPackets: 0,
        abandonedFrames: 0,
        protocolDiscontinuities: 0,
        parserHighWaterBytes: 192,
        parserRejectedAttemptBytes: 0,
        maxOutstandingPackets: 1,
        terminalCount: 0,
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

test("optional milestones preserve one spawn, listener setup, port start, and startup timer", () => {
    const milestones = [];
    const baseline = harness();
    const instrumented = harness(2, { onMilestone: (name, details) => milestones.push({ name, details }) });
    assert.deepEqual(
        milestones.map(({ name }) => name),
        [
            "pre-spawn",
            "post-spawn",
            "pre-port-start",
            "post-port-start",
            "post-child-listener-setup",
            "constructor-complete",
        ],
    );
    assert.equal(instrumented.port.startCount, baseline.port.startCount);
    for (const event of ["error", "exit", "close"])
        assert.equal(instrumented.child.listenerCount(event), baseline.child.listenerCount(event));
    assert.equal(instrumented.adapter.ownedTimerCount, baseline.adapter.ownedTimerCount);
});

test("clean END is terminal and premature EOF is rejected", async () => {
    const cleanTerminals = [];
    const clean = harness();
    clean.adapter.onTerminal = (value) => cleanTerminals.push(value);
    clean.child.stdout.emit("data", Buffer.concat([startPacket(), framed(3)]));
    assert.equal(cleanTerminals.length, 0);
    clean.child.stdout.emit("end");
    assert.equal(cleanTerminals[0].reason, "producer-ended");
    clean.child.emit("exit", 0, null);
    clean.child.emit("close", 0, null);
    await clean.adapter.stop("cleanup");

    const prematureTerminals = [];
    const premature = harness();
    premature.adapter.onTerminal = (value) => prematureTerminals.push(value);
    premature.child.stdout.emit("data", startPacket());
    premature.child.stdout.emit("end");
    assert.equal(prematureTerminals[0].reason, "malformed-producer-stream");
    premature.child.emit("exit", 0, null);
    premature.child.emit("close", 0, null);
    await premature.adapter.stop("cleanup");
});

test("trailing producer bytes after END fail through the adapter immediately", async () => {
    const terminals = [];
    const { adapter, child } = harness();
    adapter.onTerminal = (value) => terminals.push(value);
    child.stdout.emit("data", Buffer.concat([startPacket(), framed(3), Buffer.from([0x7f])]));
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0].reason, "malformed-producer-stream");
    assert.equal(child.stopInput, "STOP\n");
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
    await adapter.stop("cleanup");
});

test("stop is idempotent and sends STOP before bounded reap", async () => {
    const { adapter, child, port } = harness();
    const first = adapter.stop("test");
    assert.equal(adapter.stop("again"), first);
    assert.equal(child.stopInput, "STOP\n");
    child.exitCode = 0;
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
    await first;
    assert.equal(port.closed, true);
    assert.equal(adapter.portClosed, true);
    assert.equal(adapter.ownedTimerCount, 0);
});

test("malformed producer data is terminal", async () => {
    const { adapter, child } = harness();
    // A malformed stream is observed and drained without creating PCM backlog.
    child.stdout.emit("data", Buffer.alloc(48));
    child.stdout.emit("data", Buffer.alloc(1024));
    assert.equal(child.stopInput, "STOP\n");
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
    await adapter.stop("cleanup");
});

test("startup, progress stall, and unexpected port close each fail once", async () => {
    for (const fault of ["startup", "stall", "port"]) {
        const terminals = [];
        const fixture = harness(2, { startTimeoutMs: 10, stallTimeoutMs: 10 });
        fixture.adapter.onTerminal = (value) => terminals.push(value);
        if (fault !== "startup") fixture.child.stdout.emit("data", startPacket());
        if (fault === "port") {
            fixture.port.emit("close");
        }
        if (fault === "stall") await new Promise((resolve) => setTimeout(resolve, 20));
        if (fault === "startup") await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(
            terminals[0].reason,
            fault === "startup"
                ? "producer-start-timeout"
                : fault === "stall"
                  ? "producer-stalled"
                  : "message-port-closed",
        );
        assert.equal(fixture.adapter.stats.terminalCount, 1);
        fixture.child.exitCode = 0;
        fixture.child.emit("exit", 0, null);
        fixture.child.emit("close", 0, null);
        await fixture.adapter.stop("cleanup");
        assert.equal(fixture.adapter.ownedTimerCount, 0);
    }
});

test("real child exit before START reaches one terminal and closes within the teardown bound", async () => {
    const port = new EventEmitter();
    port.start = () => {};
    port.close = () => {};
    port.postMessage = () => {};
    let resolveTerminal;
    const terminalPromise = new Promise((resolve) => (resolveTerminal = resolve));
    const started = performance.now();
    const adapter = new ProcessLoopbackAdapter({
        executable: process.execPath,
        pid: 42,
        mode: "include",
        port,
        spawnArguments: [
            path.join(path.dirname(fileURLToPath(import.meta.url)), "r2-fault-producer.mjs"),
            "exit-before-start",
        ],
        startTimeoutMs: 250,
        stallTimeoutMs: 250,
        onTerminal: resolveTerminal,
    });
    const terminal = await terminalPromise;
    await adapter.stop("integration-cleanup");
    assert.equal(terminal.reason, "producer-exit-before-start");
    assert.equal(adapter.stats.terminalCount, 1);
    assert.equal(adapter.exitState.closed, true);
    assert.equal(adapter.exitState.exitCode, 21);
    assert.ok(performance.now() - started <= 1_500);
    assert.equal(adapter.ownedTimerCount, 0);
});

test("pre-START exit is classified identically for exit/end event order", async () => {
    for (const order of ["exit-before-end", "end-before-exit"]) {
        const fixture = harness();
        const terminals = [];
        fixture.adapter.onTerminal = (terminal) => terminals.push(terminal);
        if (order === "exit-before-end") {
            fixture.child.emit("exit", 31, null);
            assert.equal(terminals.length, 0);
            fixture.child.stdout.emit("end");
        } else {
            fixture.child.stdout.emit("end");
            fixture.child.emit("exit", 31, null);
        }
        fixture.child.emit("close", 31, null);
        await fixture.adapter.stop("cleanup");
        assert.deepEqual(
            terminals.map(({ reason }) => reason),
            ["producer-exit-before-start"],
        );
        assert.equal(fixture.adapter.stats.terminalCount, 1);
        assert.equal(fixture.adapter.exitState.exitCode, 31);
    }
});

test("specific stop during port-close grace suppresses generic terminal and clears timer", async () => {
    const fixture = harness(2, { portCloseGraceMs: 20 });
    const terminals = [];
    fixture.adapter.onTerminal = (terminal) => terminals.push(terminal);
    fixture.port.emit("close");
    assert.equal(fixture.adapter.ownedTimerCount, 2);
    const stopping = fixture.adapter.stop("bridge-renderer-crashed");
    fixture.child.emit("exit", 0, null);
    fixture.child.emit("close", 0, null);
    await stopping;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(terminals, []);
    assert.equal(fixture.adapter.ownedTimerCount, 0);
});

test("port close without competing lifecycle signal terminates once after grace", async () => {
    const fixture = harness(2, { portCloseGraceMs: 10 });
    const terminals = [];
    fixture.adapter.onTerminal = (terminal) => terminals.push(terminal);
    fixture.port.emit("close");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(
        terminals.map(({ reason }) => reason),
        ["message-port-closed"],
    );
    fixture.child.emit("exit", 0, null);
    fixture.child.emit("close", 0, null);
    await fixture.adapter.stop("cleanup");
    assert.equal(fixture.adapter.stats.terminalCount, 1);
    assert.equal(fixture.adapter.ownedTimerCount, 0);
});

test("steady fault producer honors stdout backpressure and stops cleanly", async () => {
    const child = spawnChild(process.execPath, [
        path.join(path.dirname(fileURLToPath(import.meta.url)), "r2-fault-producer.mjs"),
        "steady",
    ]);
    child.stdout.pause();
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(child.stdout.readableLength <= 256 * 1024, `readable buffer grew to ${child.stdout.readableLength}`);
    child.stdin.end("STOP\n");
    child.stdout.resume();
    const [code] = await Promise.race([
        once(child, "close"),
        new Promise((_, reject) => setTimeout(() => reject(new Error("steady producer did not close")), 1_500)),
    ]);
    assert.equal(code, 0);
});

test("real child closes stdout while alive, receives STOP, and then exits zero", async () => {
    const port = new EventEmitter();
    port.start = () => {};
    port.close = () => {};
    port.postMessage = () => {};
    let resolveFormat;
    let resolveTerminal;
    const formatPromise = new Promise((resolve) => (resolveFormat = resolve));
    const terminalPromise = new Promise((resolve) => (resolveTerminal = resolve));
    const started = performance.now();
    const adapter = new ProcessLoopbackAdapter({
        executable: process.execPath,
        pid: 42,
        mode: "include",
        port,
        spawnArguments: [
            path.join(path.dirname(fileURLToPath(import.meta.url)), "r2-fault-producer.mjs"),
            "stdout-close",
        ],
        startTimeoutMs: 500,
        stallTimeoutMs: 1_000,
        closeOutputAfterStartMs: 250,
        onFormat: resolveFormat,
        onTerminal: (terminal) => resolveTerminal({ terminal, exitedAtTerminal: adapter.exitState.exited }),
    });
    await formatPromise;
    const observation = await terminalPromise;
    assert.equal(observation.exitedAtTerminal, false);
    assert.equal(observation.terminal.reason, "malformed-producer-stream");
    await adapter.stop("integration-cleanup");
    assert.equal(adapter.stats.terminalCount, 1);
    assert.equal(adapter.exitState.closed, true);
    assert.equal(adapter.exitState.exitCode, 0);
    assert.ok(performance.now() - started <= 1_500);
});

test("ACK releases ownership while stop accounts exact unacknowledged frames as abandoned", async () => {
    const acknowledged = harness();
    acknowledged.child.stdout.emit("data", Buffer.concat([startPacket(), framed(2, Buffer.alloc(16), 0, 0)]));
    acknowledged.port.emit("message", { data: { type: "ack", sequence: 0 } });
    const acknowledgedStop = acknowledged.adapter.stop("graceful");
    acknowledged.child.emit("exit", 0, null);
    acknowledged.child.emit("close", 0, null);
    await acknowledgedStop;
    assert.equal(acknowledged.adapter.stats.inFlight, 0);
    assert.equal(acknowledged.adapter.stats.inFlightFrames, 0);
    assert.equal(acknowledged.adapter.stats.abandonedPackets, 0);
    assert.equal(acknowledged.adapter.stats.abandonedFrames, 0);

    const abandoned = harness();
    abandoned.child.stdout.emit(
        "data",
        Buffer.concat([startPacket(), framed(2, Buffer.alloc(16), 0, 0), framed(2, Buffer.alloc(16), 1, 4)]),
    );
    abandoned.port.emit("message", { data: { type: "ack", sequence: 99 } });
    abandoned.port.emit("message", { data: { type: "ack", sequence: 99 } });
    assert.equal(abandoned.adapter.stats.protocolDiscontinuities, 2);
    assert.equal(abandoned.adapter.stats.inFlight, 2);
    assert.equal(abandoned.adapter.stats.inFlightFrames, 8);
    const abandonedStop = abandoned.adapter.stop("consumer-failed");
    abandoned.child.emit("exit", 0, null);
    abandoned.child.emit("close", 0, null);
    await abandonedStop;
    assert.equal(abandoned.adapter.stats.inFlight, 0);
    assert.equal(abandoned.adapter.stats.inFlightFrames, 0);
    assert.equal(abandoned.adapter.stats.abandonedPackets, 2);
    assert.equal(abandoned.adapter.stats.abandonedFrames, 8);
});
