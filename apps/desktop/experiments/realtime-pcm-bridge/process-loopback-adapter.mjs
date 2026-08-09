/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { spawn } from "node:child_process";
import { ProcessLoopbackProtocolParser } from "./process-loopback-protocol.mjs";

const MAX_STDERR_LINE = 512;

export class ProcessLoopbackAdapter {
    constructor({
        executable,
        pid,
        mode,
        port,
        onTerminal,
        onFormat,
        spawnProcess = spawn,
        maxInFlight = 20,
        startTimeoutMs = 5_000,
        stallTimeoutMs = 5_000,
        spawnArguments,
        closeOutputAfterStartMs,
        portCloseGraceMs = 0,
        onMilestone,
    }) {
        if (!Number.isInteger(pid) || pid <= 0) throw new RangeError("pid must be positive");
        if (mode !== "include" && mode !== "exclude") throw new RangeError("mode must be include or exclude");
        this.port = port;
        this.onTerminal = onTerminal ?? (() => {});
        this.onFormat = onFormat ?? (() => {});
        this.maxInFlight = maxInFlight;
        this.stallTimeoutMs = stallTimeoutMs;
        this.closeOutputAfterStartMs = closeOutputAfterStartMs;
        this.portCloseGraceMs = portCloseGraceMs;
        this.onMilestone = onMilestone ?? (() => {});
        this.exitState = {
            exited: false,
            closed: false,
            exitCode: null,
            signal: null,
            spawnError: undefined,
            phase: "spawning",
            phaseHistory: ["spawning"],
        };
        this.stats = {
            receivedPackets: 0,
            forwardedPackets: 0,
            droppedPackets: 0,
            droppedFrames: 0,
            inFlight: 0,
            inFlightFrames: 0,
            abandonedPackets: 0,
            abandonedFrames: 0,
            protocolDiscontinuities: 0,
            parserHighWaterBytes: 0,
            parserRejectedAttemptBytes: 0,
            maxOutstandingPackets: 0,
            terminalCount: 0,
        };
        this.outstandingSequences = new Map();
        this.parser = new ProcessLoopbackProtocolParser({
            onPacket: (packet) => this.#packet(packet),
            onError: (error) => this.#terminal("malformed-producer-stream", error),
        });
        const childArguments = spawnArguments ?? ["stream", String(pid), mode];
        this.onMilestone("pre-spawn");
        this.child = spawnProcess(executable, childArguments, {
            windowsHide: true,
            stdio: ["pipe", "pipe", "pipe"],
        });
        this.onMilestone("post-spawn", { pid: this.child.pid });
        this.#phase("spawned");
        this.childClosePromise = new Promise((resolve) => {
            this.child.once("close", (code, signal) => {
                this.exitState = {
                    ...this.exitState,
                    exited: true,
                    closed: true,
                    exitCode: code,
                    signal,
                };
                this.#phase("closed");
                this.#finalizeOutput();
                resolve({ code, signal });
            });
        });
        this.onPortMessage = (event) => {
            if (event.data?.type === "ack") {
                const sequence = event.data.sequence;
                const frames = this.outstandingSequences.get(sequence);
                if (frames === undefined) {
                    this.stats.protocolDiscontinuities += 1;
                    return;
                }
                this.outstandingSequences.delete(sequence);
                this.stats.inFlight = this.outstandingSequences.size;
                this.stats.inFlightFrames -= frames;
            }
        };
        this.onPortClose = () => {
            if (this.stopping || this.portCloseTimer) return;
            if (this.portCloseGraceMs <= 0) return this.#terminal("message-port-closed");
            this.portCloseTimer = this.#ownedTimeout(() => {
                this.portCloseTimer = undefined;
                this.#terminal("message-port-closed");
            }, this.portCloseGraceMs);
        };
        this.port.on("message", this.onPortMessage);
        this.port.on("close", this.onPortClose);
        this.onMilestone("pre-port-start");
        this.port.start();
        this.onMilestone("post-port-start");
        this.startTimer = this.#ownedTimeout(() => this.#terminal("producer-start-timeout"), startTimeoutMs);
        this.child.stdout.on("data", (chunk) => {
            this.parser.push(chunk);
            this.stats.parserHighWaterBytes = this.parser.bufferHighWaterBytes;
            this.stats.parserRejectedAttemptBytes = this.parser.rejectedBufferedBytes;
        });
        this.child.stdout.on("end", () => {
            this.#finalizeOutput();
        });
        this.child.stdout.on("close", () => this.#finalizeOutput());
        this.child.stderr.setEncoding("utf8");
        this.stderrRemainder = "";
        this.child.stderr.on("data", (chunk) => this.#stderr(chunk));
        this.child.stdin.on("error", (error) => {
            if (!this.stopping) this.#terminal("producer-stdin-error", error);
        });
        this.child.on("error", (error) => {
            this.exitState.spawnError = String(error);
            this.#terminal("producer-spawn-error", error);
        });
        this.child.on("exit", (code, signal) => {
            this.exitState = { ...this.exitState, exited: true, exitCode: code, signal };
            this.#phase("exited");
        });
        this.onMilestone("post-child-listener-setup");
        this.onMilestone("constructor-complete");
    }

    #packet(packet) {
        if (packet.type === 1) {
            this.#clearTimer("startTimer");
            this.#phase("started");
            this.format = packet.format;
            this.onFormat(packet.format);
            this.#armStallTimer();
            if (Number.isFinite(this.closeOutputAfterStartMs)) {
                this.outputFaultTimer = this.#ownedTimeout(() => {
                    this.outputFaultTimer = undefined;
                    this.child.stdout.destroy();
                }, this.closeOutputAfterStartMs);
            }
            return;
        }
        if (packet.type === 3) {
            this.#clearTimer("stallTimer");
            this.#phase("ended");
            this.end = packet;
            this.stats.protocolDiscontinuities = Math.max(this.stats.protocolDiscontinuities, packet.flags);
            return;
        }
        this.stats.receivedPackets += 1;
        if (this.exitState.phase !== "streaming") this.#phase("streaming");
        this.#armStallTimer();
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
        this.stats.inFlightFrames += frames;
        this.outstandingSequences.set(packet.sequence, frames);
        this.stats.maxOutstandingPackets = Math.max(this.stats.maxOutstandingPackets, this.stats.inFlight);
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
        this.stats.terminalCount += 1;
        this.terminal = { reason, error: error ? String(error) : undefined };
        this.#phase(`terminal:${reason}`);
        const stopPromise = this.stop(reason);
        this.onTerminal(this.terminal, stopPromise);
    }

    #finalizeOutput() {
        if (this.outputFinalized || this.stopping || this.terminal) return;
        this.outputFinalized = true;
        if (!this.parser.started) return this.#terminal("producer-exit-before-start");
        this.parser.finish();
        if (this.parser.ended && !this.parser.failed)
            this.#terminal(this.end?.reason === 2 ? "target-exited" : "producer-ended");
    }

    stop(reason = "stop-requested") {
        if (this.stopPromise) return this.stopPromise;
        this.stopping = true;
        this.#phase(`stopping:${reason}`);
        this.#clearTimer("startTimer");
        this.#clearTimer("stallTimer");
        this.#clearTimer("outputFaultTimer");
        this.#clearTimer("portCloseTimer");
        this.stopPromise = new Promise((resolve, reject) => {
            const child = this.child;
            let settled = false;
            const finish = (callback) => {
                if (settled) return;
                settled = true;
                this.#clearTimer("killTimer");
                this.#clearTimer("reapTimer");
                callback();
            };
            this.killTimer = setTimeout(() => {
                this.killTimer = undefined;
                if (!this.exitState.closed) child.kill();
            }, 750);
            this.killTimer.unref?.();
            this.reapTimer = setTimeout(() => {
                this.reapTimer = undefined;
                finish(() => reject(new Error(`producer PID ${child.pid ?? "unknown"} did not close within 1000ms`)));
            }, 1_000);
            this.reapTimer.unref?.();
            this.childClosePromise.then(() => finish(resolve));
            try {
                if (!child.stdin.destroyed) child.stdin.end("STOP\n");
            } catch {
                child.kill();
            }
        }).finally(() => {
            if (!this.outstandingOwnershipFinalized) {
                this.outstandingOwnershipFinalized = true;
                this.stats.abandonedPackets += this.outstandingSequences.size;
                for (const frames of this.outstandingSequences.values()) this.stats.abandonedFrames += frames;
                this.outstandingSequences.clear();
                this.stats.inFlight = 0;
                this.stats.inFlightFrames = 0;
            }
            this.port.removeListener?.("message", this.onPortMessage);
            this.port.removeListener?.("close", this.onPortClose);
            try {
                this.port.postMessage({ type: "stop", reason });
                this.port.close();
            } catch {
                // Idempotent teardown may observe an already-closed port.
            }
            this.portClosed = true;
        });
        return this.stopPromise;
    }

    #armStallTimer() {
        this.#clearTimer("stallTimer");
        this.stallTimer = this.#ownedTimeout(() => this.#terminal("producer-stalled"), this.stallTimeoutMs);
    }

    #ownedTimeout(callback, delay) {
        if (!Number.isFinite(delay) || delay <= 0) return undefined;
        const timer = setTimeout(callback, delay);
        timer.unref?.();
        return timer;
    }

    #clearTimer(name) {
        clearTimeout(this[name]);
        this[name] = undefined;
    }

    get ownedTimerCount() {
        return (
            Number(Boolean(this.startTimer)) +
            Number(Boolean(this.stallTimer)) +
            Number(Boolean(this.killTimer)) +
            Number(Boolean(this.reapTimer)) +
            Number(Boolean(this.outputFaultTimer)) +
            Number(Boolean(this.portCloseTimer))
        );
    }

    #phase(phase) {
        if (this.exitState.phase === phase) return;
        this.exitState.phase = phase;
        this.exitState.phaseHistory.push(phase);
    }
}
