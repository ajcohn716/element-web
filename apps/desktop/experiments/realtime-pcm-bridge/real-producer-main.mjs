/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { app, BrowserWindow, desktopCapturer, ipcMain, MessageChannelMain, session, webContents } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BridgeStartupGate } from "./bridge-startup-gate.mjs";
import { HostedOwnershipLedger } from "./hosted-ownership.mjs";
import { HostedPickerOwner } from "./hosted-picker-owner.mjs";
import { ProcessLoopbackAdapter } from "./process-loopback-adapter.mjs";
import { DisplayAudioSessionController } from "./session-controller.mjs";
import { resolveWindowSource } from "./window-source-resolver.mjs";
import { hostedTeardownOracle, prepareHostedPicker, validatePickerResult } from "./real-two-party-gate.mjs";
import {
    instrumentationSource,
    isExactIsolatedPayload,
    parseElementWebUrl,
    snapshotSource,
} from "./two-party-gate.mjs";

console.error("REAL_BOOT module-entry");
const directory = path.dirname(fileURLToPath(import.meta.url));
const nativeExecutable = path.resolve(directory, "../windows-process-loopback/bin/windows-process-loopback.exe");
const enableLocalEcho = process.argv.includes("--enable-local-echo");
const realTwoParty = process.argv.includes("--real-two-party");
const elementUrlArgument = process.argv.find((argument) => argument.startsWith("--element-url="));
const elementUrl = realTwoParty ? parseElementWebUrl(elementUrlArgument?.slice("--element-url=".length)) : undefined;
const automated = process.argv.includes("--automated-real");
const bootstrapOnly = process.argv.includes("--bootstrap-only");
const autoWindowPidArgument = process.argv.find((argument) => argument.startsWith("--auto-window-pid="));
const autoWindowPid = autoWindowPidArgument ? Number(autoWindowPidArgument.split("=")[1]) : undefined;
let automatedRequest = 0;
let consumerWindow;
let quitting = false;
const resources = new Map();
const hostedOwnership = new HostedOwnershipLedger();
let lastStoppedSnapshot;
let pickerContext;
let oracleFailure = false;

async function stopSession(reason, expectedId) {
    return controller.stop(reason, expectedId);
}

function auditHostedTeardown(reason, callbackCount) {
    const owners = hostedOwnership.snapshot();
    const oracle = hostedTeardownOracle({
        state: controller.state,
        callbackCount,
        ...owners,
        adapterTimers: lastStoppedSnapshot?.adapter?.ownedTimerCount ?? 0,
        resources: resources.size,
        teardownMilliseconds: lastStoppedSnapshot?.teardownMilliseconds ?? 0,
    });
    console.log("REAL_TWO_PARTY_TEARDOWN", JSON.stringify({ reason, ...oracle }));
    if (!oracle.passed && !oracleFailure) {
        oracleFailure = true;
        console.error("REAL_TWO_PARTY_TEARDOWN_FAILURE", JSON.stringify({ reason, ...oracle }));
        setTimeout(() => app.exit(1), 0);
    }
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

class RealBridgeResource {
    constructor(id, target, videoSource) {
        this.id = id;
        this.target = target;
        this.videoSource = videoSource;
        this.startupGate = new BridgeStartupGate();
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
        this.bridgeWebContents = this.window.webContents;
        if (realTwoParty) this.releaseBridgeWindow = hostedOwnership.acquire("bridgeWindows");
        this.onBridgeGone = (_event, details) => this.terminal(`bridge-renderer-${details.reason}`);
        this.onBridgeContentsDestroyed = () => this.terminal("bridge-destroyed");
        this.onBridgeClosed = () => this.terminal("bridge-destroyed");
        this.bridgeWebContents.on("render-process-gone", this.onBridgeGone);
        this.bridgeWebContents.on("destroyed", this.onBridgeContentsDestroyed);
        this.window.on("closed", this.onBridgeClosed);
        if (realTwoParty) {
            this.releaseBridgeListeners = [0, 1, 2].map(() => hostedOwnership.acquire("ownedListeners"));
        }
        resources.set(id, this);
    }

    async start() {
        if (!this.startupGate.start()) throw new Error("bridge stopped before preparation");
        this.ready = deferred();
        this.formatReady = deferred();
        const load = this.window.loadFile(path.join(directory, "bridge.html"));
        await Promise.all([load, this.ready.promise, this.formatReady.promise]);
        await new Promise((resolve) => setTimeout(resolve, 120));
        if (this.stopped || !this.window || this.window.isDestroyed())
            throw new Error("bridge stopped during preparation");
        this.grant = {
            video: this.videoSource,
            audio: this.window.webContents.mainFrame,
            enableLocalEcho: realTwoParty ? false : enableLocalEcho,
        };
        return this;
    }

    attachPort() {
        if (!this.startupGate.claimAttachment() || this.adapter || this.stopped) return;
        const { port1, port2 } = new MessageChannelMain();
        if (realTwoParty) this.releaseMessagePort = hostedOwnership.acquire("messagePorts");
        try {
            this.adapter = new ProcessLoopbackAdapter({
                executable: nativeExecutable,
                pid: this.target.pid,
                mode: this.target.mode,
                port: port1,
                onFormat: (format) => this.formatReady.resolve(format),
                onTerminal: ({ reason, error }) => this.terminal(reason, error),
            });
            if (realTwoParty) this.releaseProducerProcess = hostedOwnership.acquire("producerProcesses");
            this.window.webContents.postMessage("pcm-port", this.id, [port2]);
        } catch (error) {
            port2.close();
            if (!this.adapter) {
                port1.close();
                this.releaseMessagePort?.();
            }
            this.terminal("producer-attachment-failed", error);
        }
    }

    bridgeReady(details) {
        if (!this.ready) return;
        this.bridgeDetails = details;
        this.ready.resolve(details);
    }

    terminal(reason, error) {
        if (this.stopped) return;
        this.failure = { reason, error };
        this.ready?.reject(new Error(error ?? reason));
        this.formatReady?.reject(new Error(error ?? reason));
        void stopSession(reason, this.id);
    }

    observeConsumer() {
        if (this.captureTimer) return;
        let observed = false;
        let falseSamples = 0;
        const started = Date.now();
        this.captureTimer = setInterval(() => {
            if (!this.window || this.window.isDestroyed()) return this.terminal("bridge-destroyed");
            const captured = this.window.webContents.isBeingCaptured();
            if (captured) {
                observed = true;
                falseSamples = 0;
            } else if (observed && ++falseSamples >= 2) {
                void stopSession("consumer-stopped", this.id);
            } else if (!observed && Date.now() - started > 5_000) {
                void stopSession("capture-never-started", this.id);
            }
        }, 50);
        if (realTwoParty) this.releaseCaptureTimer = hostedOwnership.acquire("captureTimers");
    }

    async stop(reason) {
        if (this.stopPromise) return this.stopPromise;
        this.stopped = true;
        this.startupGate.stop();
        clearInterval(this.captureTimer);
        this.captureTimer = undefined;
        this.releaseCaptureTimer?.();
        this.ready?.reject(new Error(reason));
        this.formatReady?.reject(new Error(reason));
        const stoppedAt = Date.now();
        this.stopPromise = (async () => {
            let stopError;
            try {
                await this.adapter?.stop(reason);
            } catch (error) {
                stopError = String(error);
            } finally {
                const adapterSnapshot = this.adapter
                    ? {
                          ...this.adapter.stats,
                          ...this.adapter.exitState,
                          ownedTimerCount: this.adapter.ownedTimerCount,
                          portClosed: this.adapter.portClosed === true,
                          stopError,
                      }
                    : undefined;
                const workletSnapshot = this.workletStats ? { ...this.workletStats } : undefined;
                resources.delete(this.id);
                if (this.adapter?.portClosed) this.releaseMessagePort?.();
                if (this.adapter?.exitState.closed && this.adapter?.exitState.exited) this.releaseProducerProcess?.();
                this.bridgeWebContents?.removeListener("render-process-gone", this.onBridgeGone);
                this.bridgeWebContents?.removeListener("destroyed", this.onBridgeContentsDestroyed);
                this.window?.removeListener("closed", this.onBridgeClosed);
                this.releaseBridgeListeners?.forEach((release) => release());
                if (this.window && !this.window.isDestroyed()) this.window.destroy();
                if (!this.window || this.window.isDestroyed()) this.releaseBridgeWindow?.();
                this.window = undefined;
                lastStoppedSnapshot = {
                    id: this.id,
                    reason,
                    adapter: adapterSnapshot,
                    worklet: workletSnapshot,
                    stopError,
                    teardownMilliseconds: Date.now() - stoppedAt,
                };
            }
            if (stopError) throw new Error(stopError);
        })();
        return this.stopPromise;
    }
}

async function refreshedSelection(sourceId) {
    const types = sourceId.startsWith("window:") ? ["window"] : sourceId.startsWith("screen:") ? ["screen"] : [];
    if (types.length === 0) throw new Error("unsupported source type");
    const fresh = await desktopCapturer.getSources({
        types,
        thumbnailSize: { width: 320, height: 180 },
        fetchWindowIcons: false,
    });
    const source = fresh.find((candidate) => candidate.id === sourceId);
    if (!source) throw new Error("selected source is stale");
    if (types[0] === "screen") return { source, target: { pid: process.pid, mode: "exclude" } };
    const identity = await resolveWindowSource(nativeExecutable, source.id);
    return { source, target: { pid: identity.pid, mode: "include" } };
}

const controller = new DisplayAudioSessionController({
    prepare: async ({ id, selection, registerResource }) => {
        const { source, target } = await refreshedSelection(selection);
        const resource = new RealBridgeResource(id, target, source);
        if (!registerResource(resource)) {
            await resource.stop("stale-before-preparation");
            throw new Error("session became stale before preparation");
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
        if (transition.state === "Selecting") lastStoppedSnapshot = undefined;
        if (realTwoParty && transition.state === "Stopping" && pickerContext?.requestId === transition.id) {
            const picker = pickerContext;
            pickerContext = undefined;
            picker.close(transition.stopReason ?? "session-stopping");
        }
        console.log("REAL_SESSION", JSON.stringify(transition));
        if (realTwoParty && transition.state === "Idle") {
            queueMicrotask(() => auditHostedTeardown(transition.stopReason ?? "unknown", transition.callbackCount));
        }
    },
});

function bindRequester(request, id, metadata) {
    const requester = webContents.fromFrame(request.frame);
    if (!requester) return void stopSession("requester-destroyed", id);
    const stop = (reason) => void stopSession(reason, id);
    const onNavigation = (details) => {
        if (!details.isSameDocument && details.frame?.frameTreeNodeId === metadata.frameTreeNodeId)
            stop("requester-navigated");
    };
    const onGone = (_event, details) => stop(`requester-renderer-${details.reason}`);
    const onDestroyed = () => stop("requester-destroyed");
    requester.on("did-start-navigation", onNavigation);
    requester.on("render-process-gone", onGone);
    requester.on("destroyed", onDestroyed);
    const releaseListeners = realTwoParty ? [0, 1, 2].map(() => hostedOwnership.acquire("ownedListeners")) : [];
    let disposed = false;
    metadata.dispose = () => {
        if (disposed) return;
        disposed = true;
        requester.removeListener("did-start-navigation", onNavigation);
        requester.removeListener("render-process-gone", onGone);
        requester.removeListener("destroyed", onDestroyed);
        releaseListeners.forEach((release) => release());
    };
}

async function armHostedFrame(frame) {
    if (!frame || frame.detached || frame.isDestroyed()) return false;
    try {
        return (await frame.executeJavaScript(instrumentationSource()))?.armed === true;
    } catch {
        return false;
    }
}

async function armHostedFrames() {
    const frames = consumerWindow?.webContents.mainFrame?.framesInSubtree ?? [];
    const armedFrames = (await Promise.all(frames.map((frame) => armHostedFrame(frame)))).filter(Boolean).length;
    console.log("REAL_TWO_PARTY_INSTRUMENTATION_ARMED", JSON.stringify({ armedFrames }));
}

async function openHostedPicker(requestId, available) {
    if (pickerContext) {
        const previous = pickerContext;
        pickerContext = undefined;
        previous.close("picker-replaced");
    }
    const window = new BrowserWindow({
        parent: consumerWindow,
        modal: true,
        width: 940,
        height: 680,
        show: false,
        webPreferences: {
            preload: path.join(directory, "real-picker-preload.cjs"),
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
        },
    });
    const owner = new HostedPickerOwner({
        requestId,
        sourceIds: new Set(available.map((source) => source.id)),
        window,
        ownership: hostedOwnership,
        onCancel: (cancelledId, reason) => {
            if (pickerContext !== owner) return;
            pickerContext = undefined;
            controller.cancel(cancelledId, reason);
        },
    });
    pickerContext = owner;
    await window.loadFile(path.join(directory, "real-picker.html"));
    if (pickerContext !== owner || window.isDestroyed()) return;
    window.webContents.send("real-two-party-picker-open", {
        requestId,
        sources: available.map((source) => ({
            id: source.id,
            name: source.name,
            thumbnail: source.thumbnail.toDataURL(),
        })),
    });
    window.show();
}

async function run() {
    app.enableSandbox();
    console.error("REAL_BOOT before-app-ready");
    await app.whenReady();
    console.error("REAL_BOOT after-app-ready");

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
    ipcMain.on("real-picker-result", async (event, result) => {
        if (event.sender !== consumerWindow?.webContents || result?.requestId !== controller.active?.id) return;
        if (!result.sourceId) return void controller.cancel(result.requestId);
        await controller.select(result.requestId, result.sourceId);
    });
    ipcMain.on("real-two-party-picker-result", async (event, result) => {
        const context = pickerContext;
        if (!realTwoParty || !context) return;
        const validated = validatePickerResult({
            sender: event.sender,
            expectedSender: context.window.webContents,
            result,
            requestId: context.requestId,
            sourceIds: context.sourceIds,
        });
        if (!validated.accepted) return;
        pickerContext = undefined;
        context.close(validated.sourceId === null ? "picker-cancelled" : "picker-selected");
        if (validated.sourceId === null) return void controller.cancel(context.requestId);
        await controller.select(context.requestId, validated.sourceId);
    });
    ipcMain.handle("real-session-diagnostics", () => ({
        state: controller.state,
        resources: resources.size,
        producer: controller.active?.resource?.adapter?.stats,
        worklet: controller.active?.resource?.workletStats,
        lastStopped: lastStoppedSnapshot,
    }));

    session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
        const frame = request.frame;
        if (!frame || frame.detached || frame.isDestroyed()) return callback({ video: { id: "", name: "" } });
        if (realTwoParty) {
            let snapshot;
            try {
                snapshot = await frame.executeJavaScript(snapshotSource());
            } catch {
                snapshot = null;
            }
            if (!isExactIsolatedPayload(snapshot)) {
                console.error(
                    "REAL_TWO_PARTY_REQUEST_REJECTED",
                    JSON.stringify({ reason: "initial constraints not armed or not exact" }),
                );
                callback({ video: { id: "", name: "" } });
                return;
            }
            console.log("REAL_TWO_PARTY_REQUEST_ACCEPTED", JSON.stringify(snapshot));
        }
        const metadata = { frameTreeNodeId: frame.frameTreeNodeId };
        const id = await controller.beginReplacing(callback, metadata);
        bindRequester(request, id, metadata);
        const enumerateSources = () =>
            desktopCapturer.getSources({
                types: ["window", "screen"],
                thumbnailSize: { width: 320, height: 180 },
                fetchWindowIcons: false,
            });
        if (realTwoParty) {
            await prepareHostedPicker({
                requestId: id,
                enumerateSources,
                openPicker: openHostedPicker,
                isCurrent: (requestId) => controller.active?.id === requestId,
                onFailure: (requestId, reason) => controller.cancel(requestId, reason),
            });
            return;
        }
        try {
            const available = await enumerateSources();
            if (controller.active?.id !== id) return;
            if (automated) {
                let selected;
                if (automatedRequest++ === 0) {
                    const windows = available.filter((source) => source.id.startsWith("window:"));
                    const identities = await Promise.all(
                        windows.map(async (source) => {
                            try {
                                return { source, identity: await resolveWindowSource(nativeExecutable, source.id) };
                            } catch {
                                return undefined;
                            }
                        }),
                    );
                    selected = identities.find((entry) => entry?.identity.pid === autoWindowPid)?.source;
                } else {
                    selected = available.find((source) => source.id.startsWith("screen:"));
                }
                if (!selected) return void controller.cancel(id, "automated-source-not-found");
                await controller.select(id, selected.id);
                return;
            }
            consumerWindow.webContents.send("real-picker-open", {
                requestId: id,
                sources: available.map((source) => ({
                    id: source.id,
                    name: source.name,
                    thumbnail: source.thumbnail.toDataURL(),
                })),
            });
        } catch {
            controller.cancel(id, "source-selection-failed");
        }
    });

    if (realTwoParty) {
        session.defaultSession.setPermissionRequestHandler((requestingWebContents, permission, callback) => {
            callback(requestingWebContents === consumerWindow?.webContents && permission === "media");
        });
    }

    consumerWindow = new BrowserWindow({
        show: !automated,
        width: 1000,
        height: 820,
        webPreferences: {
            preload: realTwoParty ? undefined : path.join(directory, "real-consumer-preload.cjs"),
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
        },
    });
    if (realTwoParty) {
        consumerWindow.webContents.on("frame-created", (_event, details) => {
            const frame = details.frame;
            if (frame) frame.once("dom-ready", () => void armHostedFrame(frame));
        });
        consumerWindow.webContents.on("did-finish-load", () => void armHostedFrames());
    }
    consumerWindow.on("closed", () => {
        consumerWindow = undefined;
        void stopSession("requester-closed");
    });
    if (realTwoParty) await consumerWindow.loadURL(elementUrl.href);
    else
        await consumerWindow.loadFile(
            path.join(directory, automated ? "real-gate-consumer.html" : "real-consumer.html"),
        );
    console.error("REAL_BOOT consumer-loaded");
    if (bootstrapOnly) {
        console.error("REAL_BOOT bootstrap-complete");
        await stopSession("bootstrap-complete");
        app.exit(0);
    } else if (automated) {
        try {
            console.log("REAL_PRODUCER_GATE_ARMED");
            const results = await Promise.race([
                consumerWindow.webContents.executeJavaScript("window.runRealProducerGate()", true),
                new Promise((_, reject) => setTimeout(() => reject(new Error("real producer gate timed out")), 30_000)),
            ]);
            const [includeLeft, includeRight] = results.include.channels;
            const [excludeLeft, excludeRight] = results.exclude.channels;
            const db = (wanted, rejected) => 20 * Math.log10(Math.max(wanted, 1e-9) / Math.max(rejected, 1e-9));
            const assertions = {
                includeLeftSeparationDb: db(
                    includeLeft.tone733,
                    Math.max(includeLeft.tone997, includeLeft.unrelated1319, includeLeft.element1553),
                ),
                includeRightSeparationDb: db(
                    includeRight.tone997,
                    Math.max(includeRight.tone733, includeRight.unrelated1319, includeRight.element1553),
                ),
                excludeExternalVsElementDb: db(
                    Math.min(
                        excludeLeft.tone733,
                        excludeRight.tone997,
                        Math.max(excludeLeft.unrelated1319, excludeRight.unrelated1319),
                    ),
                    Math.max(excludeLeft.element1553, excludeRight.element1553),
                ),
                excludeLeftSeparationDb: db(excludeLeft.tone733, excludeLeft.tone997),
                excludeRightSeparationDb: db(excludeRight.tone997, excludeRight.tone733),
            };
            const expectedSettings = {
                autoGainControl: false,
                noiseSuppression: false,
                echoCancellation: false,
                channelCount: 2,
            };
            const captures = [results.include, results.exclude];
            for (const [index, capture] of captures.entries()) {
                for (const [key, value] of Object.entries(expectedSettings)) {
                    if (capture.settings[key] !== value)
                        throw new Error(`capture ${index} setting ${key}=${capture.settings[key]}, expected ${value}`);
                }
                if ("voiceIsolation" in capture.settings && capture.settings.voiceIsolation !== false)
                    throw new Error(`capture ${index} unexpectedly enabled voiceIsolation`);
                if (capture.contextState !== "running" || capture.sampleRate !== 48_000)
                    throw new Error(`capture ${index} analysis context was not running at 48kHz`);
                const producer = capture.beforeStop.producer;
                const worklet = capture.beforeStop.worklet;
                if (!producer || !worklet)
                    throw new Error(`capture ${index} did not snapshot producer/worklet metrics`);
                if (
                    producer.inFlight > 20 ||
                    producer.droppedPackets !== 0 ||
                    producer.droppedFrames !== 0 ||
                    producer.protocolDiscontinuities !== 0 ||
                    worklet.capacityFrames !== 9_600 ||
                    worklet.maxQueuedFrames > 9_600 ||
                    worklet.droppedFrames !== 0 ||
                    worklet.discontinuities !== 0
                )
                    throw new Error(
                        `capture ${index} transport metrics failed: ${JSON.stringify({ producer, worklet })}`,
                    );
                if (
                    capture.afterStop.state !== "Idle" ||
                    capture.afterStop.resources !== 0 ||
                    capture.teardownMilliseconds > 1_000 ||
                    capture.afterStop.lastStopped?.teardownMilliseconds > 1_000
                )
                    throw new Error(`capture ${index} teardown failed: ${JSON.stringify(capture)}`);
                const stoppedAdapter = capture.afterStop.lastStopped?.adapter;
                if (!stoppedAdapter?.exited || stoppedAdapter.stopError || capture.afterStop.lastStopped?.stopError)
                    throw new Error(
                        `capture ${index} producer teardown proof failed: ${JSON.stringify(stoppedAdapter)}`,
                    );
            }
            const floor = 0.01;
            if (
                results.elementContextState !== "running" ||
                includeLeft.tone733 < floor ||
                includeRight.tone997 < floor ||
                excludeLeft.tone733 < floor ||
                excludeRight.tone997 < floor ||
                Math.max(excludeLeft.unrelated1319, excludeRight.unrelated1319) < floor ||
                assertions.includeLeftSeparationDb < 20 ||
                assertions.includeRightSeparationDb < 20 ||
                assertions.excludeExternalVsElementDb < 20 ||
                assertions.excludeLeftSeparationDb < 20 ||
                assertions.excludeRightSeparationDb < 20
            )
                throw new Error(`real producer isolation assertion failed: ${JSON.stringify(assertions)}`);
            await new Promise((resolve) => setTimeout(resolve, 500));
            if (controller.state !== "Idle" || resources.size !== 0)
                throw new Error("real producer resources did not return to zero");
            console.log("REAL_PRODUCER_RESULTS", JSON.stringify({ results, assertions }));
            console.log(
                "REAL_PRODUCER_STARTUP_UNDERRUN",
                JSON.stringify(captures.map((capture) => capture.beforeStop.worklet.underrunFrames)),
            );
            await stopSession("automated-complete");
            app.exit(0);
        } catch (error) {
            console.error("REAL_PRODUCER_FAILURE", error);
            await stopSession("automated-failure");
            app.exit(1);
        }
    }

    app.on("before-quit", (event) => {
        if (quitting) return;
        if (controller.state === "Idle" && resources.size === 0) return;
        event.preventDefault();
        quitting = true;
        void stopSession("application-shutdown")
            .then(() => {
                if (controller.state !== "Idle" || resources.size !== 0)
                    throw new Error("application shutdown left real-producer resources active");
                app.exit(oracleFailure ? 1 : 0);
            })
            .catch((error) => {
                console.error("REAL_PRODUCER_SHUTDOWN_FAILURE", error);
                app.exit(1);
            });
    });
    app.on("window-all-closed", () => app.quit());
}

void run().catch(async (error) => {
    console.error(
        "REAL_BOOT startup-failed",
        realTwoParty ? "hosted window load or setup failed" : error instanceof Error ? error.message : String(error),
    );
    try {
        await stopSession("startup-failed");
    } catch (stopError) {
        console.error(
            "REAL_BOOT startup-stop-failed",
            stopError instanceof Error ? stopError.message : String(stopError),
        );
    }
    app.exit(1);
});
