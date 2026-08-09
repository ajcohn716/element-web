/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { spawn } from "node:child_process";
import { ProcessLoopbackProtocolParser } from "./process-loopback-protocol.mjs";

const MAX_STDERR_LINE = 512;

export class ProcessLoopbackAdapter {
    constructor({ executable, pid, mode, port, onTerminal, onFormat, spawnProcess = spawn, maxInFlight = 20 }) {
        if (!Number.isInteger(pid) || pid <= 0) throw new RangeError("pid must be positive");
        if (mode !== "include" && mode !== "exclude") throw new RangeError("mode must be include or exclude");
        this.port = port;
        this.onTerminal = onTerminal ?? (() => {});
        this.onFormat = onFormat ?? (() => {});
        this.maxInFlight = maxInFlight;
        this.exitState = { exited: false, exitCode: null, signal: null, spawnError: undefined };
        this.stats = {
            receivedPackets: 0,
            forwardedPackets: 0,
            droppedPackets: 0,
            droppedFrames: 0,
            inFlight: 0,
            protocolDiscontinuities: 0,
        };
        this.outstandingSequences = new Set();
        this.parser = new ProcessLoopbackProtocolParser({
            onPacket: (packet) => this.#packet(packet),
            onError: (error) => this.#terminal("malformed-producer-stream", error),
        });
        this.child = spawnProcess(executable, ["stream", String(pid), mode], {
            windowsHide: true,
            stdio: ["pipe", "pipe", "pipe"],
        });
        this.onPortMessage = (event) => {
            if (event.data?.type === "ack") {
                const sequence = event.data.sequence;
                if (!this.outstandingSequences.delete(sequence)) {
                    this.stats.protocolDiscontinuities += 1;
                    return;
                }
                this.stats.inFlight = this.outstandingSequences.size;
            }
        };
        this.port.on("message", this.onPortMessage);
        this.port.start();
        this.child.stdout.on("data", (chunk) => this.parser.push(chunk));
        this.child.stdout.on("end", () => {
            if (this.stopping) return;
            this.parser.finish();
            if (this.parser.ended && !this.parser.failed)
                this.#terminal(this.end?.reason === 2 ? "target-exited" : "producer-ended");
        });
        this.child.stderr.setEncoding("utf8");
        this.stderrRemainder = "";
        this.child.stderr.on("data", (chunk) => this.#stderr(chunk));
        this.child.on("error", (error) => {
            this.exitState.spawnError = String(error);
            this.#terminal("producer-spawn-error", error);
        });
        this.child.on("exit", (code, signal) => {
            this.exitState = { ...this.exitState, exited: true, exitCode: code, signal };
            if (!this.stopping && !this.terminal) {
                if (this.parser.ended && !this.parser.failed)
                    this.#terminal(this.end?.reason === 2 ? "target-exited" : "producer-ended");
                else this.#terminal("producer-exit", new Error(`code=${code} signal=${signal}`));
            }
        });
    }

    #packet(packet) {
        if (packet.type === 1) {
            this.format = packet.format;
            this.onFormat(packet.format);
            return;
        }
        if (packet.type === 3) {
            this.end = packet;
            this.stats.protocolDiscontinuities = Math.max(this.stats.protocolDiscontinuities, packet.flags);
            return;
        }
        this.stats.receivedPackets += 1;
        if ((packet.flags & 1) !== 0) this.stats.protocolDiscontinuities += 1;
        const frames = packet.payload.byteLength / 4;
        if (this.stats.inFlight >= this.maxInFlight) {
            this.stats.droppedPackets += 1;
            this.stats.droppedFrames += frames;
            return;
        }
        const pcm = packet.payload.buffer.slice(
            packet.payload.byteOffset,
            packet.payload.byteOffset + packet.payload.byteLength,
        );
        this.port.postMessage({
            type: "pcm",
            sequence: packet.sequence,
            startFrame: packet.startFrame,
            flags: packet.flags,
            pcm,
        });
        this.stats.inFlight += 1;
        this.outstandingSequences.add(packet.sequence);
        this.stats.forwardedPackets += 1;
    }

    #stderr(chunk) {
        this.stderrRemainder = (this.stderrRemainder + chunk).slice(-MAX_STDERR_LINE * 2);
        const lines = this.stderrRemainder.split(/\r?\n/);
        this.stderrRemainder = lines.pop() ?? "";
        for (const line of lines) {
            // oxlint-disable-next-line no-control-regex
            const safe = line.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, MAX_STDERR_LINE);
            if (safe) console.error("process-loopback:", safe);
        }
    }

    #terminal(reason, error) {
        if (this.terminal) return;
        this.terminal = { reason, error: error ? String(error) : undefined };
        this.onTerminal(this.terminal);
        void this.stop(reason);
    }

    stop(reason = "stop-requested") {
        if (this.stopPromise) return this.stopPromise;
        this.stopping = true;
        this.stopPromise = new Promise((resolve, reject) => {
            const child = this.child;
            if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
            const killTimeout = setTimeout(() => child.kill(), 750);
            killTimeout.unref?.();
            const reapTimeout = setTimeout(() => {
                child.removeListener("exit", onExit);
                reject(new Error(`producer PID ${child.pid ?? "unknown"} did not exit within 1000ms`));
            }, 1_000);
            reapTimeout.unref?.();
            const onExit = () => {
                clearTimeout(killTimeout);
                clearTimeout(reapTimeout);
                resolve();
            };
            child.once("exit", onExit);
            try {
                child.stdin.end("STOP\n");
            } catch {
                child.kill();
            }
        }).finally(() => {
            this.port.removeListener?.("message", this.onPortMessage);
            try {
                this.port.postMessage({ type: "stop", reason });
                this.port.close();
            } catch {
                // Idempotent teardown may observe an already-closed port.
            }
        });
        return this.stopPromise;
    }
}
