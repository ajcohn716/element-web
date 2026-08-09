/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { app, BrowserWindow, desktopCapturer, ipcMain, MessageChannelMain, session, webContents } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BridgeStartupGate } from "./bridge-startup-gate.mjs";
import { ProcessLoopbackAdapter } from "./process-loopback-adapter.mjs";
import { OwnedListenerAudit } from "./owned-listener-audit.mjs";
import { R2ResourceLedger } from "./r2-resource-ledger.mjs";
import { DisplayAudioSessionController } from "./session-controller.mjs";
import { resolveWindowSource } from "./window-source-resolver.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const nativeExecutable = path.resolve(directory, "../windows-process-loopback/bin/windows-process-loopback.exe");
const faultProducer = path.join(directory, "r2-fault-producer.mjs");
const caseName = process.argv.find((argument) => argument.startsWith("--r2-case="))?.split("=")[1];
const nodeExecutable = process.argv.find((argument) => argument.startsWith("--r2-node="))?.slice("--r2-node=".length);
const targetPid = Number(process.argv.find((argument) => argument.startsWith("--r2-target-pid="))?.split("=")[1]);
const markerPath = process.argv
    .find((argument) => argument.startsWith("--r2-marker-log="))
    ?.slice("--r2-marker-log=".length);
if (!caseName || !nodeExecutable) throw new Error("R2 requires --r2-case and --r2-node");
if (!markerPath) throw new Error("R2 requires --r2-marker-log");
const markerFd = fs.openSync(markerPath, "a");

const ledger = new R2ResourceLedger(caseName);
const resources = new Map();
const completed = new Map();
const scheduledTimers = new Map();
const listenerAudits = [];
const producerLifecycle = [];
const resourceLifecycle = [];
const requesterWindows = [];
const firstPreparationBarrier = Promise.withResolvers();
const stalePreparationPending = Promise.withResolvers();
const phases = [];
let consumerWindow;
let requestNumber = 0;
let finalizing = false;
let shuttingDown = false;
let rendererResult;
let releaseStalePreparation;
let targetWasLive = false;
let targetWasLiveAtConsumerStop = false;
let heartbeatTimer;
let releaseHeartbeat;
let heartbeatCount = 0;
let markerClosed = false;

function recordPhase(phase, details = {}) {
    const entry = { phase, ...details };
    phases.push(entry);
    console.log("R2_PHASE", JSON.stringify(entry));
}

function durableMarker(phase, details = {}) {
    if (markerClosed) return;
    fs.writeSync(markerFd, `${JSON.stringify({ phase, ...details })}\n`);
}

function closeMarker() {
    if (markerClosed) return;
    markerClosed = true;
    fs.closeSync(markerFd);
}

function isProcessLive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function startHeartbeat() {
    if (heartbeatTimer) return;
    releaseHeartbeat = ledger.track("timers", "main-heartbeat");
    heartbeatTimer = setInterval(() => recordPhase("main-heartbeat", { count: ++heartbeatCount }), 500);
}

function stopHeartbeat() {
    if (!heartbeatTimer) return;
    clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
    releaseHeartbeat?.();
    releaseHeartbeat = undefined;
}

const producerScenario = new Map([
    ["cancel-startup", "delayed-start"],
    ["exit-before-start", "exit-before-start"],
    ["init-reject", "init-reject"],
    ["unsupported-simulated", "unsupported-simulated"],
    ["crash-active", "crash-active"],
    ["stdout-close", "stdout-close"],
    ["truncated", "truncated"],
    ["malformed", "malformed"],
    ["stall", "stall"],
    ["adapter-burst", "burst"],
    ["queue-overflow", "queue-overflow"],
]);

const caseOracles = {
    "malformed-source": { callbacks: ["rejected"], stopReasons: ["startup-failed"], active: false, producer: false },
    "stale-hwnd": { callbacks: ["rejected"], stopReasons: ["startup-failed"], active: false, producer: false },
    "dead-pid": {
        callbacks: ["rejected"],
        stopReasons: ["producer-exit-before-start"],
        terminalReasons: ["producer-exit-before-start"],
        adapterTerminalCounts: [1],
        exitCodes: [1],
        active: false,
        producer: true,
    },
    "missing-exe": {
        callbacks: ["rejected"],
        stopReasons: ["producer-spawn-error"],
        terminalReasons: ["producer-spawn-error"],
        adapterTerminalCounts: [1],
        active: false,
        producer: false,
    },
    "exit-before-start": {
        callbacks: ["rejected"],
        stopReasons: ["producer-exit-before-start"],
        terminalReasons: ["producer-exit-before-start"],
        adapterTerminalCounts: [1],
        exitCodes: [21],
        active: false,
        producer: true,
    },
    "init-reject": {
        callbacks: ["rejected"],
        stopReasons: ["producer-exit-before-start"],
        terminalReasons: ["producer-exit-before-start"],
        adapterTerminalCounts: [1],
        exitCodes: [22],
        active: false,
        producer: true,
    },
    "unsupported-simulated": {
        callbacks: ["rejected"],
        stopReasons: ["producer-exit-before-start"],
        terminalReasons: ["producer-exit-before-start"],
        adapterTerminalCounts: [1],
        exitCodes: [23],
        active: false,
        producer: true,
    },
    "crash-active": {
        callbacks: ["granted"],
        stopReasons: ["malformed-producer-stream"],
        terminalReasons: ["malformed-producer-stream"],
        adapterTerminalCounts: [1],
        exitCodes: [24],
        active: true,
        producer: true,
    },
    "stdout-close": {
        callbacks: ["granted"],
        stopReasons: ["malformed-producer-stream"],
        terminalReasons: ["malformed-producer-stream"],
        adapterTerminalCounts: [1],
        exitCodes: [0],
        active: true,
        producer: true,
    },
    "truncated": {
        callbacks: ["granted"],
        stopReasons: ["malformed-producer-stream"],
        terminalReasons: ["malformed-producer-stream"],
        adapterTerminalCounts: [1],
        exitCodes: [0],
        active: true,
        producer: true,
    },
    "malformed": {
        callbacks: ["granted"],
        stopReasons: ["malformed-producer-stream"],
        terminalReasons: ["malformed-producer-stream"],
        adapterTerminalCounts: [1],
        exitCodes: [0],
        active: true,
        producer: true,
    },
    "stall": {
        callbacks: ["granted"],
        stopReasons: ["producer-stalled"],
        terminalReasons: ["producer-stalled"],
        adapterTerminalCounts: [1],
        exitCodes: [0],
        active: true,
        producer: true,
    },
    "native-target-exit": {
        callbacks: ["granted"],
        stopReasons: ["target-exited"],
        terminalReasons: ["target-exited"],
        adapterTerminalCounts: [1],
        exitCodes: [0],
        active: true,
        producer: true,
    },
    "native-success": {
        callbacks: ["granted"],
        stopReasons: ["consumer-stopped"],
        adapterTerminalCounts: [0],
        exitCodes: [0],
        active: true,
        producer: true,
    },
    "adapter-burst": {
        callbacks: ["granted"],
        stopReasons: ["adapter-burst-complete"],
        adapterTerminalCounts: [0],
        active: true,
        producer: true,
        adapterDrops: true,
    },
    "queue-overflow": {
        callbacks: ["granted"],
        stopReasons: ["queue-overflow-complete"],
        adapterTerminalCounts: [0],
        active: true,
        producer: true,
        workletDrops: true,
    },
    "bridge-destroy": {
        callbacks: ["granted"],
        stopReasons: ["bridge-destroyed"],
        adapterTerminalCounts: [0],
        active: true,
        producer: true,
    },
    "bridge-crash": {
        callbacks: ["granted"],
        stopReasons: ["bridge-renderer-crashed"],
        adapterTerminalCounts: [0],
        active: true,
        producer: true,
        abandoned: true,
    },
    "missing-worklet": {
        callbacks: ["rejected"],
        stopReasons: ["bridge-failed"],
        terminalReasons: ["bridge-failed"],
        adapterTerminalCounts: [0],
        active: false,
        producer: true,
    },
    "close-port": {
        callbacks: ["granted"],
        stopReasons: ["message-port-closed"],
        terminalReasons: ["message-port-closed"],
        adapterTerminalCounts: [1],
        active: true,
        producer: true,
    },
    "audio-track-stop": {
        callbacks: ["granted"],
        stopReasons: ["consumer-stopped"],
        adapterTerminalCounts: [0],
        active: true,
        producer: true,
    },
    "all-tracks-stop": {
        callbacks: ["granted"],
        stopReasons: ["consumer-stopped"],
        adapterTerminalCounts: [0],
        active: true,
        producer: true,
    },
    "requester-navigate": {
        callbacks: ["granted"],
        stopReasons: ["requester-navigated"],
        adapterTerminalCounts: [0],
        active: true,
        producer: true,
    },
    "requester-close": {
        callbacks: ["granted"],
        stopReasons: ["requester-destroyed"],
        adapterTerminalCounts: [0],
        active: true,
        producer: true,
    },
    "requester-crash": {
        callbacks: ["granted"],
        stopReasons: ["requester-renderer-crashed"],
        adapterTerminalCounts: [0],
        active: true,
        producer: true,
    },
    "replace-active": {
        callbacks: ["granted", "granted"],
        stopReasons: ["replaced", "consumer-stopped"],
        adapterTerminalCounts: [0, 0],
        active: true,
        producer: true,
    },
    "replace-preparing": {
        callbacks: ["rejected", "granted"],
        stopReasons: ["replaced", "consumer-stopped"],
        adapterTerminalCounts: [0],
        active: true,
        producer: true,
    },
    "cancel-startup": {
        callbacks: ["rejected"],
        stopReasons: ["cancelled-during-startup"],
        adapterTerminalCounts: [0],
        exitCodes: [0],
        active: false,
        producer: true,
    },
    "cancel-prebuffer": {
        callbacks: ["rejected"],
        stopReasons: ["cancelled-during-prebuffer"],
        adapterTerminalCounts: [0],
        exitCodes: [0],
        active: false,
        producer: true,
    },
    "stale-preparation": {
        callbacks: ["rejected", "granted"],
        stopReasons: ["replaced", "consumer-stopped"],
        adapterTerminalCounts: [0],
        active: true,
        producer: true,
        staleCompletions: 1,
    },
    "picker-cancel": { callbacks: ["rejected"], stopReasons: ["picker-cancelled"], active: false, producer: false },
    "app-quit": {
        callbacks: ["granted"],
        stopReasons: ["application-shutdown"],
        adapterTerminalCounts: [0],
        active: true,
        producer: true,
    },
    "explicit-shutdown": {
        callbacks: ["granted"],
        stopReasons: ["application-shutdown"],
        adapterTerminalCounts: [0],
        active: true,
        producer: true,
    },
    "success": {
        callbacks: ["granted"],
        stopReasons: ["consumer-stopped"],
        adapterTerminalCounts: [0],
        active: true,
        producer: true,
    },
};

function wait(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function completedSessions() {
    return [...completed.values()].sort((left, right) => left.id - right.id);
}

function scheduleOwned(token, callback, milliseconds) {
    const release = ledger.track("timers", token);
    const timer = setTimeout(() => {
        scheduledTimers.delete(token);
        release();
        callback();
    }, milliseconds);
    scheduledTimers.set(token, { timer, release });
}

function clearScheduledTimers() {
    for (const { timer, release } of scheduledTimers.values()) {
        clearTimeout(timer);
        release();
    }
    scheduledTimers.clear();
}

function clearSessionTimers(id) {
    for (const [token, { timer, release }] of scheduledTimers) {
        if (!token.startsWith(`${id}:`)) continue;
        clearTimeout(timer);
        release();
        scheduledTimers.delete(token);
    }
}

async function waitFor(predicate, label, timeout = 1_500) {
    const started = performance.now();
    while (!predicate()) {
        if (performance.now() - started > timeout) throw new Error(`timed out waiting for ${label}`);
        await wait(10);
    }
}

class R2BridgeResource {
    constructor(id, target, videoSource, fault) {
        this.id = id;
        this.target = target;
        this.videoSource = videoSource;
        this.fault = fault;
        this.startupGate = new BridgeStartupGate();
        this.captureObserved = Promise.withResolvers();
        this.releaseResource = ledger.track("resources", id);
        resourceLifecycle.push({ sessionId: this.id, event: "created" });
        this.window = new BrowserWindow({
            show: false,
            webPreferences: {
                preload: path.join(directory, "bridge-preload.cjs"),
                sandbox: true,
                contextIsolation: true,
                nodeIntegration: false,
                backgroundThrottling: false,
            },
        });
        this.releaseWindow = ledger.track("windows", this.window.id);
        this.bridgeListenerAudit = new OwnedListenerAudit(`${id}:bridge`);
        this.bridgeListenerReleases = [];
        listenerAudits.push(this.bridgeListenerAudit);
        this.onBridgeGone = (_event, details) => this.terminal(`bridge-renderer-${details?.reason ?? "destroyed"}`);
        this.onBridgeClosed = () => {
            this.releaseWindow?.();
            this.releaseWindow = undefined;
            this.disposeBridgeListeners();
            this.terminal("bridge-destroyed");
        };
        this.addBridgeListener(this.window.webContents, "render-process-gone", this.onBridgeGone);
        this.addBridgeListener(this.window, "closed", this.onBridgeClosed);
        resources.set(id, this);
    }

    addBridgeListener(emitter, event, callback) {
        this.bridgeListenerAudit.add(emitter, event, callback, `bridge-${event}`);
        const release = ledger.track("listeners", `${this.id}:bridge:${event}`);
        this.bridgeListenerReleases.push(release);
    }

    disposeBridgeListeners() {
        if (this.bridgeListenersDisposed) return;
        this.bridgeListenersDisposed = true;
        this.bridgeListenerAudit.dispose();
        this.bridgeListenerReleases.splice(0).forEach((release) => release());
    }

    delay(milliseconds, name) {
        const token = `${this.id}:${name}`;
        const release = ledger.track("timers", token);
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                this.delays.delete(timer);
                release();
                resolve();
            }, milliseconds);
            (this.delays ??= new Map()).set(timer, { release, resolve });
        });
    }

    clearDelays() {
        for (const [timer, { release, resolve }] of this.delays ?? []) {
            clearTimeout(timer);
            release();
            resolve();
        }
        this.delays?.clear();
    }

    armPreparingReplacementBarrier() {
        if (this.preparingReplacementBarrier) return this.preparingReplacementBarrier.promise;
        const deferred = Promise.withResolvers();
        const releaseBarrierOwner = ledger.track("barriers", `${this.id}:preparation`);
        const releaseTimerOwner = ledger.track("timers", `${this.id}:preparation-safety`);
        const timer = setTimeout(() => {
            this.preparingReplacementBarrier = undefined;
            releaseTimerOwner();
            releaseBarrierOwner();
            deferred.reject(new Error("preparing replacement barrier safety deadline expired"));
        }, 1_500);
        this.preparingReplacementBarrier = {
            promise: deferred.promise,
            release: (reason) => {
                if (!this.preparingReplacementBarrier) return;
                this.preparingReplacementBarrier = undefined;
                clearTimeout(timer);
                releaseTimerOwner();
                releaseBarrierOwner();
                deferred.resolve(reason);
            },
        };
        return deferred.promise;
    }

    releasePreparingReplacementBarrier(reason) {
        this.preparingReplacementBarrier?.release(reason);
    }

    async start() {
        recordPhase("resource-start-entry", { sessionId: this.id });
        if (!this.startupGate.start()) throw new Error("bridge stopped before R2 preparation");
        this.ready = Promise.withResolvers();
        this.formatReady = Promise.withResolvers();
        const bridgeFault = this.fault === "missing-worklet" ? "missing-worklet" : "";
        const query = bridgeFault ? { query: { "r2-fault": bridgeFault } } : undefined;
        const load = this.window.loadFile(path.join(directory, "bridge.html"), query);
        await Promise.all([load, this.ready.promise, this.formatReady.promise]);
        if (this.fault === "cancel-prebuffer") {
            const prebuffer = this.delay(300, "prebuffer");
            recordPhase("cancel-prebuffer-ready", { sessionId: this.id });
            queueMicrotask(() => void controller.stop("cancelled-during-prebuffer", this.id));
            await prebuffer;
        } else {
            await this.delay(80, "prebuffer");
        }
        if (this.stopped || this.window.isDestroyed()) throw new Error("bridge stopped during R2 preparation");
        this.grant = { video: this.videoSource, audio: this.window.webContents.mainFrame, enableLocalEcho: false };
        return this;
    }

    attachPort() {
        if (!this.startupGate.claimAttachment() || this.adapter || this.stopped) return;
        recordPhase("port-attach", { sessionId: this.id });
        durableMarker("message-channel-before", { sessionId: this.id });
        const { port1, port2 } = new MessageChannelMain();
        durableMarker("message-channel-after", { sessionId: this.id });
        durableMarker("port-ledger-before", { sessionId: this.id });
        this.port = port1;
        this.releasePort = ledger.track("ports", `${this.id}:main`);
        durableMarker("port-ledger-after", { sessionId: this.id });
        let executable = nativeExecutable;
        let spawnArguments;
        if (this.fault === "missing-exe") executable = path.join(directory, "definitely-missing-r2-producer.exe");
        else if (producerScenario.has(this.fault)) {
            executable = nodeExecutable;
            spawnArguments = [faultProducer, producerScenario.get(this.fault)];
        } else if (!new Set(["native-target-exit", "native-success", "dead-pid"]).has(this.fault)) {
            executable = nodeExecutable;
            spawnArguments = [faultProducer, "steady"];
        }
        recordPhase("adapter-constructor-before", { sessionId: this.id });
        durableMarker("adapter-constructor-before", { sessionId: this.id });
        this.adapter = new ProcessLoopbackAdapter({
            executable,
            pid: this.target.pid,
            mode: this.target.mode,
            port: port1,
            spawnArguments,
            maxInFlight: 20,
            closeOutputAfterStartMs: new Set(["stdout-close", "truncated", "malformed"]).has(this.fault)
                ? 350
                : undefined,
            portCloseGraceMs: new Set(["bridge-crash", "close-port"]).has(this.fault) ? 50 : 0,
            startTimeoutMs: 250,
            stallTimeoutMs: this.fault === "stall" ? 250 : 2_000,
            onMilestone: (milestone, details) => {
                recordPhase(`adapter-${milestone}`, { sessionId: this.id, pid: details?.pid });
                durableMarker(`adapter-${milestone}`, { sessionId: this.id, pid: details?.pid });
            },
            onFormat: (format) => {
                durableMarker("producer-start-format", {
                    sessionId: this.id,
                    sampleRate: format.sampleRate,
                    channels: format.channels,
                    bitsPerSample: format.bitsPerSample,
                    blockAlign: format.blockAlign,
                    bytesPerSecond: format.bytesPerSecond,
                });
                recordPhase("producer-format", { sessionId: this.id });
                this.formatReady.resolve(format);
            },
            onTerminal: ({ reason, error }) => {
                console.error("R2_PHASE", JSON.stringify({ session: this.id, phase: "terminal", reason }));
                this.terminal(reason, error);
            },
        });
        durableMarker("adapter-constructor-after", { sessionId: this.id, pid: this.adapter.child.pid });
        recordPhase("adapter-constructor-after", { sessionId: this.id, pid: this.adapter.child.pid });
        const child = this.adapter.child;
        if (child.pid) {
            producerLifecycle.push({ sessionId: this.id, event: "created", pid: child.pid });
            this.releaseProducer = ledger.trackProducer(child.pid);
            child.once("close", () => {
                producerLifecycle.push({ sessionId: this.id, event: "closed", pid: child.pid });
                this.releaseProducer?.();
                this.releaseProducer = undefined;
            });
            if (this.fault === "cancel-startup") {
                recordPhase("cancel-startup-producer-created", { sessionId: this.id });
                queueMicrotask(() => void controller.stop("cancelled-during-startup", this.id));
            }
        }
        recordPhase("port-transfer-before", { sessionId: this.id });
        durableMarker("port-transfer-before", { sessionId: this.id });
        this.window.webContents.postMessage(
            "pcm-port",
            { sessionId: this.id, r2Fault: this.fault === "close-port" ? "close-port" : undefined },
            [port2],
        );
        durableMarker("port-transfer-after", { sessionId: this.id });
        recordPhase("port-transfer-after", { sessionId: this.id });
    }

    bridgeReady(details) {
        if (!this.ready) return;
        this.bridgeDetails = details;
        durableMarker("bridge-ready", { sessionId: this.id });
        recordPhase("bridge-ready", { sessionId: this.id });
        this.ready.resolve(details);
    }

    terminal(reason, error) {
        if (this.stopped) return;
        this.terminalReason = reason;
        this.failure = error ? String(error) : undefined;
        this.ready?.reject(new Error(error ?? reason));
        this.formatReady?.reject(new Error(error ?? reason));
        void controller.stop(reason, this.id);
    }

    observeConsumer() {
        if (this.captureTimer) return;
        let observed = false;
        let falseSamples = 0;
        const timerToken = `${this.id}:capture`;
        const releaseTimer = ledger.track("timers", timerToken);
        const started = performance.now();
        this.captureTimer = setInterval(() => {
            if (!this.window || this.window.isDestroyed()) return this.terminal("bridge-destroyed");
            const captured = this.window.webContents.isBeingCaptured();
            if (captured) {
                observed = true;
                this.captureObservedTrue = true;
                this.captureObserved.resolve(true);
                falseSamples = 0;
            } else if (observed && ++falseSamples >= 2) {
                this.captureFalseSamples = falseSamples;
                if (caseName === "native-success") targetWasLiveAtConsumerStop = isProcessLive(targetPid);
                void controller.stop("consumer-stopped", this.id);
            } else if (!observed && performance.now() - started > 1_000) {
                void controller.stop("capture-never-started", this.id);
            }
        }, 25);
        this.releaseCaptureTimer = () => {
            clearInterval(this.captureTimer);
            releaseTimer();
            this.releaseCaptureTimer = undefined;
        };
    }

    async waitForCaptureObserved() {
        if (this.captureObservedTrue) return;
        await Promise.race([
            this.captureObserved.promise,
            this.delay(1_500, "capture-observed-deadline").then(() => {
                if (!this.captureObservedTrue) throw new Error("timed out waiting for R2 capture observation");
            }),
        ]);
    }

    async stop(reason) {
        if (this.stopPromise) return this.stopPromise;
        this.stopCount = (this.stopCount ?? 0) + 1;
        this.stopped = true;
        this.startupGate.stop();
        this.releasePreparingReplacementBarrier(reason);
        this.releaseCaptureTimer?.();
        this.clearDelays();
        this.ready?.reject(new Error(reason));
        this.formatReady?.reject(new Error(reason));
        const started = performance.now();
        this.stopPromise = (async () => {
            let stopError;
            try {
                await this.adapter?.stop(reason);
            } catch (error) {
                stopError = String(error);
            }
            this.releasePort?.();
            this.releasePort = undefined;
            const adapter = this.adapter
                ? { ...this.adapter.stats, ...this.adapter.exitState, ownedTimers: this.adapter.ownedTimerCount }
                : undefined;
            resources.delete(this.id);
            this.releaseResource?.();
            this.releaseResource = undefined;
            if (this.window && !this.window.isDestroyed()) this.window.destroy();
            this.disposeBridgeListeners();
            this.releaseWindow?.();
            this.releaseWindow = undefined;
            this.window = undefined;
            resourceLifecycle.push({ sessionId: this.id, event: "closed" });
            const teardownMilliseconds = performance.now() - started;
            ledger.maxTeardownMilliseconds = Math.max(ledger.maxTeardownMilliseconds, teardownMilliseconds);
            completed.set(this.id, {
                id: this.id,
                reason,
                terminalReason: this.terminalReason,
                adapter,
                worklet: this.workletStats ? { ...this.workletStats } : undefined,
                stopError,
                teardownMilliseconds,
                activeReached: ledger.transitions.some(
                    (transition) => transition.id === this.id && transition.state === "Active",
                ),
                stopCount: this.stopCount,
                captureObservedTrue: Boolean(this.captureObservedTrue),
                captureFalseSamples: this.captureFalseSamples ?? 0,
            });
            if (stopError) throw new Error(stopError);
        })();
        return this.stopPromise;
    }
}

async function prepareSelection(selection) {
    if (caseName === "malformed-source") throw new Error("malformed source ID");
    if (caseName === "stale-hwnd") await resolveWindowSource(nativeExecutable, "window:1:0");
    const started = performance.now();
    recordPhase("source-enumeration-before");
    const screens = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width: 0, height: 0 },
        fetchWindowIcons: false,
    });
    recordPhase("source-enumeration-after", { durationMilliseconds: performance.now() - started });
    if (!screens[0]) throw new Error("no screen source available for R2 video");
    return { source: screens[0], target: { pid: targetPid || process.pid, mode: "include" }, selection };
}

const controller = new DisplayAudioSessionController({
    prepare: async ({ id, selection, registerResource }) => {
        recordPhase("prepare-entry", { sessionId: id });
        const selected = await prepareSelection(selection);
        if (caseName === "stale-preparation" && requestNumber === 1) {
            const deferred = Promise.withResolvers();
            const releaseBarrierOwner = ledger.track("barriers", `${id}:stale-selection`);
            const releaseTimerOwner = ledger.track("timers", `${id}:stale-selection-safety`);
            const timer = setTimeout(() => {
                releaseStalePreparation = undefined;
                releaseTimerOwner();
                releaseBarrierOwner();
                deferred.reject(new Error("stale selection safety deadline expired"));
            }, 1_500);
            releaseStalePreparation = () => {
                if (!releaseStalePreparation) return;
                releaseStalePreparation = undefined;
                clearTimeout(timer);
                releaseTimerOwner();
                releaseBarrierOwner();
                deferred.resolve();
            };
            recordPhase("stale-selection-pending", { sessionId: id });
            stalePreparationPending.resolve({ id });
            await deferred.promise;
            recordPhase("stale-selection-released", { sessionId: id });
        }
        recordPhase("resource-construct", { sessionId: id });
        const resource = new R2BridgeResource(id, selected.target, selected.source, caseName);
        if (!registerResource(resource)) {
            await resource.stop("stale-before-register");
            if (caseName === "stale-preparation" && id === 1) return resource;
            throw new Error("stale before R2 registration");
        }
        if (caseName === "replace-preparing" && requestNumber === 1) {
            const barrier = resource.armPreparingReplacementBarrier();
            recordPhase("prepare-barrier-enter", { sessionId: id });
            firstPreparationBarrier.resolve({ id, resource });
            const releaseReason = await barrier;
            recordPhase("prepare-barrier-release", { sessionId: id, reason: releaseReason });
            if (resource.stopped) throw new Error("preparing resource stopped before producer startup");
        }
        try {
            await resource.start();
            resource.observeConsumer();
            return resource;
        } catch (error) {
            await resource.stop("startup-failed");
            throw error;
        }
    },
    onTransition: (transition) => {
        ledger.transition(transition);
        if (transition.state === "Idle") clearSessionTimers(transition.id);
        if (caseName === "native-target-exit" && transition.state === "Active" && targetPid) {
            scheduleOwned(
                `${transition.id}:target-exit`,
                () => {
                    recordPhase("native-target-terminate", { sessionId: transition.id, targetPid });
                    try {
                        process.kill(targetPid);
                    } catch {
                        // The deterministic target may already have exited.
                    }
                },
                100,
            );
        }
    },
    onStaleCompletion: () => {
        ledger.staleCompletions += 1;
        ledger.staleObservations.push({
            activeId: controller.active?.id,
            activeGeneration: controller.active?.generation,
            activeResourceId: controller.active?.resource?.id,
        });
    },
});

function bindRequester(request, id, metadata) {
    const requester = webContents.fromFrame(request.frame);
    if (!requester) return void controller.stop("requester-destroyed", id);
    const audit = new OwnedListenerAudit(`${id}:requester`);
    listenerAudits.push(audit);
    const releases = [];
    const add = (event, listener) => {
        audit.add(requester, event, listener, `requester-${event}`);
        const token = `${id}:${event}:${releases.length}`;
        const release = ledger.track("listeners", token);
        releases.push(release);
    };
    add("did-start-navigation", (details) => {
        if (!details.isSameDocument && details.frame?.frameTreeNodeId === metadata.frameTreeNodeId)
            void controller.stop("requester-navigated", id);
    });
    add("render-process-gone", (_event, details) => void controller.stop(`requester-renderer-${details.reason}`, id));
    add("destroyed", () => void controller.stop("requester-destroyed", id));
    let disposed = false;
    metadata.dispose = () => {
        if (disposed) return;
        disposed = true;
        audit.dispose();
        releases.splice(0).forEach((release) => release());
    };
}

async function assertAndExit() {
    if (finalizing) return;
    finalizing = true;
    stopHeartbeat();
    try {
        await waitFor(() => controller.state === "Idle" && resources.size === 0, "R2 controller quiescence");
        for (const window of requesterWindows) {
            if (!window.isDestroyed()) window.destroy();
        }
        await waitFor(() => requesterWindows.every((window) => window.isDestroyed()), "R2 requester destruction");
        await wait(50);
        const ownedListenerChecks = listenerAudits.map((audit) => audit.assertDisposed());
        for (const stopped of completedSessions()) {
            if (!stopped.adapter) continue;
            if (stopped.adapter.ownedTimers !== 0) throw new Error(`adapter ${stopped.id} retained timers`);
            if (stopped.adapter.inFlight !== 0 || stopped.adapter.inFlightFrames !== 0)
                throw new Error(`adapter ${stopped.id} retained live packet/frame ownership`);
            if (stopped.adapter.maxOutstandingPackets > 20) throw new Error("adapter exceeded 20 in-flight packets");
            if (stopped.adapter.parserHighWaterBytes > 384_096) throw new Error("parser exceeded fixed buffer cap");
        }
        if (caseName === "adapter-burst") {
            const adapter = completedSessions().at(-1)?.adapter;
            if (!adapter || adapter.droppedPackets <= 0 || adapter.droppedFrames <= 0)
                throw new Error("adapter burst did not exercise bounded drop-newest policy");
        }
        if (caseName === "queue-overflow") {
            const stopped = completedSessions().at(-1);
            if (stopped?.adapter?.droppedFrames !== 0)
                throw new Error("queue overflow unexpectedly dropped in the adapter");
            if (
                !stopped?.worklet ||
                stopped.worklet.capacityFrames !== 9_600 ||
                stopped.worklet.maxQueuedFrames !== 9_600 ||
                stopped.worklet.droppedFrames < 38_400 ||
                stopped.worklet.discontinuities !== 0
            )
                throw new Error("worklet overflow did not reach cap with at least 38400 clean frame drops");
            if (
                stopped.adapter.receivedPackets !== 1 ||
                stopped.adapter.forwardedPackets !== 1 ||
                stopped.adapter.maxOutstandingPackets > 1 ||
                stopped.adapter.protocolDiscontinuities !== 0
            )
                throw new Error("queue-overflow adapter did not forward exactly one clean maximum packet");
        }
        if (caseName === "audio-track-stop" || caseName === "all-tracks-stop") {
            const stopped = completedSessions().at(-1);
            if (!stopped?.captureObservedTrue || stopped.captureFalseSamples < 2)
                throw new Error("track stop did not prove captured true followed by debounced false");
            const expectedVideoState = caseName === "audio-track-stop" ? "live" : "ended";
            if (rendererResult?.audioState !== "ended" || rendererResult?.videoState !== expectedVideoState)
                throw new Error(
                    `track states audio=${rendererResult?.audioState} video=${rendererResult?.videoState}, expected ended/${expectedVideoState}`,
                );
        }
        const result = ledger.assertQuiescent(controller);
        const sessions = completedSessions();
        const oracle = caseOracles[caseName];
        if (!oracle) throw new Error(`R2 case ${caseName} has no acceptance oracle`);
        const assertExact = (label, actual, expected) => {
            if (expected !== undefined && JSON.stringify(actual) !== JSON.stringify(expected))
                throw new Error(`R2 ${label}=${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
        };
        const callbackResults = result.callbacks.map((request) => request.callbackResult);
        assertExact("callback results", callbackResults, oracle.callbacks);
        const stopReasons = ledger.transitions
            .filter((transition) => transition.state === "Stopping")
            .map((transition) => transition.stopReason);
        assertExact("stop reasons", stopReasons, oracle.stopReasons);
        const terminalReasons = sessions.map((stopped) => stopped.terminalReason).filter(Boolean);
        assertExact("terminal reasons", terminalReasons, oracle.terminalReasons);
        const adapterTerminalCounts = sessions
            .filter((stopped) => stopped.adapter)
            .map((stopped) => stopped.adapter.terminalCount);
        assertExact("adapter terminal counts", adapterTerminalCounts, oracle.adapterTerminalCounts);
        const exitCodes = sessions.filter((stopped) => stopped.adapter).map((stopped) => stopped.adapter.exitCode);
        assertExact("producer exit codes", exitCodes, oracle.exitCodes);
        const activeReached = ledger.transitions.some((transition) => transition.state === "Active");
        if (oracle.active !== undefined && activeReached !== oracle.active)
            throw new Error(`R2 Active reached=${activeReached}, expected ${oracle.active}`);
        const producerCreated = result.producerPidHistory.length > 0;
        if (oracle.producer !== undefined && producerCreated !== oracle.producer)
            throw new Error(`R2 producer created=${producerCreated}, expected ${oracle.producer}`);
        if (oracle.staleCompletions !== undefined && result.staleCompletions !== oracle.staleCompletions)
            throw new Error(`R2 stale completions=${result.staleCompletions}, expected ${oracle.staleCompletions}`);
        if (caseName === "stale-preparation") {
            assertExact("first stale requester result", rendererResult?.first?.result, "rejected");
            assertExact("stale replacement requester result", rendererResult?.second, { result: "granted", tracks: 2 });
            assertExact("stale replacement live tracks", rendererResult?.secondStatesBeforeStop, {
                audio: "live",
                video: "live",
            });
            assertExact("stale observations", result.staleObservations, [
                { activeId: 2, activeGeneration: 2, activeResourceId: 2 },
            ]);
            if (
                sessions[0]?.id !== 1 ||
                sessions[0].reason !== "stale-before-register" ||
                sessions[0].stopCount !== 1 ||
                sessions[0].activeReached ||
                sessions[0].adapter
            )
                throw new Error("stale resource was not stopped exactly once without replacing session 2");
            if (
                sessions[1]?.id !== 2 ||
                sessions[1].reason !== "consumer-stopped" ||
                !sessions[1].activeReached ||
                !sessions[1].adapter ||
                result.producerPidHistory.length !== 1
            )
                throw new Error("stale completion mutated the accepted replacement owner");
        }
        if (caseName === "picker-cancel") {
            if (
                result.maxResources !== 0 ||
                result.maxBridgeWindows !== 0 ||
                result.maxMessagePorts !== 0 ||
                result.maxProducerProcesses !== 0 ||
                result.producerPidHistory.length !== 0
            )
                throw new Error("picker cancellation allocated capture resources before rejection");
        }
        if (caseName === "replace-active") {
            assertExact("returned track states after replacement", rendererResult?.statesAfterReplacement, {
                firstAudio: "ended",
                firstVideo: "live",
                secondAudio: "live",
                secondVideo: "live",
            });
            assertExact(
                "replacement sessions",
                sessions.map(({ id, reason, activeReached, stopCount }) => ({ id, reason, activeReached, stopCount })),
                [
                    { id: 1, reason: "replaced", activeReached: true, stopCount: 1 },
                    { id: 2, reason: "consumer-stopped", activeReached: true, stopCount: 1 },
                ],
            );
            if (result.producerPidHistory.length !== 2 || new Set(result.producerPidHistory).size !== 2)
                throw new Error("active replacement did not create exactly two sequential producers");
            if (result.maxProducerProcesses !== 1 || result.maxResources !== 1)
                throw new Error(
                    `active replacement overlapped ownership: producers=${result.maxProducerProcesses} resources=${result.maxResources}`,
                );
            assertExact(
                "producer lifecycle",
                producerLifecycle.map(({ sessionId, event }) => ({ sessionId, event })),
                [
                    { sessionId: 1, event: "created" },
                    { sessionId: 1, event: "closed" },
                    { sessionId: 2, event: "created" },
                    { sessionId: 2, event: "closed" },
                ],
            );
        }
        if (caseName === "replace-preparing") {
            assertExact("first requester result", rendererResult?.first?.result, "rejected");
            assertExact("second requester result", rendererResult?.second, { result: "granted", tracks: 2 });
            assertExact("second requester live tracks", rendererResult?.secondStatesBeforeStop, {
                audio: "live",
                video: "live",
            });
            assertExact(
                "replacement sessions",
                sessions.map(({ id, reason, activeReached, stopCount, adapter }) => ({
                    id,
                    reason,
                    activeReached,
                    stopCount,
                    producerCreated: Boolean(adapter),
                })),
                [
                    { id: 1, reason: "replaced", activeReached: false, stopCount: 1, producerCreated: false },
                    { id: 2, reason: "consumer-stopped", activeReached: true, stopCount: 1, producerCreated: true },
                ],
            );
            if (result.producerPidHistory.length !== 1)
                throw new Error("preparing replacement did not create exactly one producer");
            if (result.maxResources !== 1 || result.maxBridgeWindows !== 1 || result.maxProducerProcesses !== 1)
                throw new Error(
                    `preparing replacement overlapped ownership: resources=${result.maxResources} windows=${result.maxBridgeWindows} producers=${result.maxProducerProcesses}`,
                );
            if (!sessions[1]?.captureObservedTrue)
                throw new Error("preparing replacement did not observe second consumer capture before stop");
            assertExact("resource lifecycle", resourceLifecycle, [
                { sessionId: 1, event: "created" },
                { sessionId: 1, event: "closed" },
                { sessionId: 2, event: "created" },
                { sessionId: 2, event: "closed" },
            ]);
            assertExact(
                "producer lifecycle",
                producerLifecycle.map(({ sessionId, event }) => ({ sessionId, event })),
                [
                    { sessionId: 2, event: "created" },
                    { sessionId: 2, event: "closed" },
                ],
            );
        }
        if (caseName === "cancel-startup") {
            const stopped = sessions[0];
            if (
                !stopped?.adapter ||
                stopped.adapter.receivedPackets !== 0 ||
                stopped.adapter.phaseHistory.some((phase) => phase === "started" || phase === "streaming")
            )
                throw new Error("startup cancellation did not stop after spawn and before START/streaming");
            assertExact(
                "startup cancellation producer lifecycle",
                producerLifecycle.map(({ sessionId, event }) => ({ sessionId, event })),
                [
                    { sessionId: 1, event: "created" },
                    { sessionId: 1, event: "closed" },
                ],
            );
        }
        if (caseName === "cancel-prebuffer") {
            const stopped = sessions[0];
            if (!stopped?.adapter?.phaseHistory.includes("started") || stopped.activeReached)
                throw new Error("prebuffer cancellation did not occur after format and before Active");
            if (
                !phases.some((entry) => entry.phase === "bridge-ready" && entry.sessionId === 1) ||
                !phases.some((entry) => entry.phase === "producer-format" && entry.sessionId === 1) ||
                !phases.some((entry) => entry.phase === "cancel-prebuffer-ready" && entry.sessionId === 1)
            )
                throw new Error("prebuffer cancellation omitted exact bridge/format/prebuffer phase evidence");
        }
        if (caseName === "native-target-exit") {
            if (!targetWasLive || isProcessLive(targetPid))
                throw new Error(
                    `native target lifecycle liveBefore=${targetWasLive} liveAfter=${isProcessLive(targetPid)}`,
                );
        }
        if (caseName === "native-success") {
            const stopped = sessions[0];
            if (!targetWasLive || !targetWasLiveAtConsumerStop || !isProcessLive(targetPid))
                throw new Error(
                    `native success target lifecycle startup=${targetWasLive} consumerStop=${targetWasLiveAtConsumerStop} final=${isProcessLive(targetPid)}`,
                );
            if (!stopped?.adapter || stopped.adapter.receivedPackets <= 0)
                throw new Error("native success producer did not deliver any protocol packets");
        }
        if (oracle.abandoned && !sessions.some((stopped) => stopped.adapter?.abandonedPackets > 0))
            throw new Error("R2 failure did not account unacknowledged packets as abandoned");
        console.log(
            "R2_CASE_RESULT",
            JSON.stringify({
                ...result,
                oracle: { ...oracle, passed: true },
                stopReasons,
                terminalReasons,
                ownedListenerChecks,
                producerLifecycle,
                resourceLifecycle,
                requestersDestroyed: requesterWindows.every((window) => window.isDestroyed()),
                targetWasLive,
                targetWasLiveAtConsumerStop,
                targetAbsent: targetPid ? !isProcessLive(targetPid) : undefined,
                phases,
                sessions,
            }),
        );
        closeMarker();
        app.exit(0);
    } catch (error) {
        console.error("R2_CASE_FAILURE", error, "R2_FINAL_PHASES", JSON.stringify(phases));
        closeMarker();
        app.exit(1);
    }
}

async function shutdownThroughBeforeQuit() {
    if (shuttingDown) return;
    shuttingDown = true;
    clearScheduledTimers();
    await controller.stop("application-shutdown");
    await assertAndExit();
}

async function run() {
    app.enableSandbox();
    await app.whenReady();
    if (caseName === "native-target-exit" || caseName === "native-success") {
        targetWasLive = isProcessLive(targetPid);
        if (!targetWasLive) throw new Error("native target was not live at Electron startup");
        recordPhase("native-target-live", { targetPid });
    }
    ipcMain.on("pcm-bridge-request-port", (event) => {
        const resource = [...resources.values()].find((candidate) => candidate.window?.webContents === event.sender);
        resource?.attachPort();
    });
    ipcMain.on("pcm-bridge-ready", (event, details) => {
        const resource = [...resources.values()].find((candidate) => candidate.window?.webContents === event.sender);
        resource?.bridgeReady(details);
    });
    ipcMain.on("pcm-bridge-stats", (event, stats) => {
        const resource = [...resources.values()].find((candidate) => candidate.window?.webContents === event.sender);
        if (resource) resource.workletStats = stats;
    });
    ipcMain.on("pcm-bridge-failed", (event, error) => {
        const resource = [...resources.values()].find((candidate) => candidate.window?.webContents === event.sender);
        resource?.terminal("bridge-failed", String(error));
    });
    ipcMain.handle("r2-command", async (_event, command) => {
        const resource = controller.active?.resource;
        if (command === "bridge-destroy") resource?.window?.destroy();
        else if (command === "bridge-crash") resource?.window?.webContents.forcefullyCrashRenderer();
        else if (command === "requester-navigate")
            void consumerWindow.loadFile(path.join(directory, "r2-consumer.html"));
        else if (command === "requester-close") consumerWindow.close();
        else if (command === "requester-crash") consumerWindow.webContents.forcefullyCrashRenderer();
        else if (command === "cancel-prebuffer") await controller.stop("cancelled-during-prebuffer");
        else if (command === "app-quit") app.quit();
        else if (command === "explicit-shutdown") await shutdownThroughBeforeQuit();
        else if (command === "wait-capture-observed") {
            if (!resource) throw new Error("no active R2 resource to observe");
            await resource.waitForCaptureObserved();
        } else if (command === "release-stale-preparation") {
            releaseStalePreparation?.();
            await waitFor(() => ledger.staleCompletions === 1, "one stale preparation completion");
        }
        return true;
    });

    session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
        const frame = request.frame;
        if (!frame || frame.detached || frame.isDestroyed()) return callback({ video: { id: "", name: "" } });
        const metadata = { frameTreeNodeId: frame.frameTreeNodeId };
        recordPhase("display-handler-entry", { nextRequest: requestNumber + 1 });
        const wrappedCallback = (grant) => {
            const callbackResult = grant.video?.id === "" ? "rejected" : "granted";
            ledger.callback(id, callbackResult);
            recordPhase("display-callback", { sessionId: id, result: callbackResult });
            durableMarker("display-callback-before", { sessionId: id, result: callbackResult });
            callback(grant);
            durableMarker("display-callback-complete", { sessionId: id, result: callbackResult });
        };
        const id = await controller.beginReplacing(wrappedCallback, metadata);
        recordPhase("display-owner-begun", { sessionId: id });
        ledger.request(id);
        requestNumber += 1;
        bindRequester(request, id, metadata);
        if (caseName === "picker-cancel") return void controller.cancel(id, "picker-cancelled");
        recordPhase("display-select-before", { sessionId: id });
        await controller.select(id, "r2-selection");
        recordPhase("display-select-after", { sessionId: id });
    });

    const createRequesterWindow = async () => {
        const window = new BrowserWindow({
            show: false,
            webPreferences: {
                preload: path.join(directory, "r2-consumer-preload.cjs"),
                sandbox: true,
                contextIsolation: true,
                nodeIntegration: false,
            },
        });
        requesterWindows.push(window);
        const requesterId = requesterWindows.length;
        recordPhase("requester-created", { requesterId });
        window.on("closed", () => recordPhase("requester-closed", { requesterId }));
        window.webContents.on("render-process-gone", (_event, details) =>
            recordPhase("requester-render-gone", { requesterId, reason: details.reason }),
        );
        window.webContents.on("destroyed", () => recordPhase("requester-webcontents-destroyed", { requesterId }));
        await window.loadFile(path.join(directory, "r2-consumer.html"));
        recordPhase("requester-loaded", { requesterId });
        return window;
    };
    consumerWindow = await createRequesterWindow();
    consumerWindow.on("closed", () => void controller.stop("requester-closed"));
    console.log("R2_CASE_ARMED", caseName);
    startHeartbeat();
    try {
        const rendererCase = async () => {
            if (!new Set(["replace-preparing", "stale-preparation"]).has(caseName))
                return consumerWindow.webContents.executeJavaScript(
                    `window.runR2Case(${JSON.stringify(caseName)})`,
                    true,
                );
            recordPhase("requester-gdm-invoked", { requesterId: 1 });
            const firstCapture = consumerWindow.webContents.executeJavaScript("window.startR2Capture()", true);
            const preparationSignal =
                caseName === "replace-preparing" ? firstPreparationBarrier.promise : stalePreparationPending.promise;
            await Promise.race([
                preparationSignal,
                wait(1_500).then(() => {
                    throw new Error("first requester did not enter the preparation barrier");
                }),
            ]);
            const secondWindow = await createRequesterWindow();
            recordPhase("requester-gdm-invoked", { requesterId: 2 });
            const second = await secondWindow.webContents.executeJavaScript("window.startR2Capture()", true);
            let secondStatesBeforeStop;
            if (caseName === "stale-preparation") {
                secondStatesBeforeStop = await secondWindow.webContents.executeJavaScript(
                    "window.waitForHeldCaptureObservation()",
                    true,
                );
                await secondWindow.webContents.executeJavaScript(
                    'window.r2Host.command("release-stale-preparation")',
                    true,
                );
                await secondWindow.webContents.executeJavaScript("window.stopHeldCapture()", true);
            } else {
                secondStatesBeforeStop = await secondWindow.webContents.executeJavaScript(
                    "window.stopHeldCaptureAfterObservation()",
                    true,
                );
            }
            const first = await firstCapture;
            return { first, second, secondStatesBeforeStop };
        };
        rendererResult = await Promise.race([
            rendererCase(),
            wait(4_000).then(() => {
                throw new Error("R2 renderer case timed out");
            }),
        ]);
    } catch (error) {
        if (!["requester-navigate", "requester-close", "requester-crash", "app-quit"].includes(caseName)) throw error;
    }
    if (caseName === "adapter-burst" || caseName === "queue-overflow") {
        await wait(caseName === "queue-overflow" ? 1_300 : 300);
        await controller.stop(`${caseName}-complete`);
    }
    if (!shuttingDown) await assertAndExit();
}

app.on("before-quit", (event) => {
    recordPhase("before-quit", { finalizing, shuttingDown });
    if (finalizing) return;
    event.preventDefault();
    void shutdownThroughBeforeQuit();
});

app.on("window-all-closed", () => recordPhase("window-all-closed", { finalizing, shuttingDown }));
app.on("will-quit", () => recordPhase("will-quit", { finalizing, shuttingDown }));
app.on("quit", (_event, exitCode) => recordPhase("quit", { exitCode }));

void run().catch(async (error) => {
    stopHeartbeat();
    console.error("R2_CASE_FAILURE", error, "R2_FINAL_PHASES", JSON.stringify(phases));
    try {
        await controller.stop("r2-failure");
    } finally {
        closeMarker();
        app.exit(1);
    }
});
