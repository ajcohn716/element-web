/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { app, BrowserWindow, desktopCapturer, ipcMain, MessageChannelMain, session, webContents } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ProcessLoopbackAdapter } from "./process-loopback-adapter.mjs";
import { DisplayAudioSessionController } from "./session-controller.mjs";
import { resolveWindowSource } from "./window-source-resolver.mjs";

console.error("REAL_BOOT module-entry");
const directory = path.dirname(fileURLToPath(import.meta.url));
const nativeExecutable = path.resolve(directory, "../windows-process-loopback/bin/windows-process-loopback.exe");
const enableLocalEcho = process.argv.includes("--enable-local-echo");
const automated = process.argv.includes("--automated-real");
const bootstrapOnly = process.argv.includes("--bootstrap-only");
const autoWindowPidArgument = process.argv.find((argument) => argument.startsWith("--auto-window-pid="));
const autoWindowPid = autoWindowPidArgument ? Number(autoWindowPidArgument.split("=")[1]) : undefined;
let automatedRequest = 0;
let consumerWindow;
let quitting = false;
const resources = new Map();
let lastStoppedSnapshot;

async function stopSession(reason, expectedId) {
    return controller.stop(reason, expectedId);
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
        this.ready = deferred();
        this.formatReady = deferred();
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
        this.window.webContents.on("render-process-gone", (_event, details) =>
            this.terminal(`bridge-renderer-${details.reason}`),
        );
        this.window.on("closed", () => this.terminal("bridge-destroyed"));
        resources.set(id, this);
    }

    async start() {
        const load = this.window.loadFile(path.join(directory, "bridge.html"));
        await Promise.all([load, this.ready.promise, this.formatReady.promise]);
        await new Promise((resolve) => setTimeout(resolve, 120));
        if (this.stopped || !this.window || this.window.isDestroyed())
            throw new Error("bridge stopped during preparation");
        this.grant = { video: this.videoSource, audio: this.window.webContents.mainFrame, enableLocalEcho };
        return this;
    }

    attachPort() {
        if (this.adapter || this.stopped) return;
        const { port1, port2 } = new MessageChannelMain();
        this.adapter = new ProcessLoopbackAdapter({
            executable: nativeExecutable,
            pid: this.target.pid,
            mode: this.target.mode,
            port: port1,
            onFormat: (format) => this.formatReady.resolve(format),
            onTerminal: ({ reason, error }) => this.terminal(reason, error),
        });
        this.window.webContents.postMessage("pcm-port", this.id, [port2]);
    }

    bridgeReady(details) {
        this.bridgeDetails = details;
        this.ready.resolve(details);
    }

    terminal(reason, error) {
        if (this.stopped) return;
        this.failure = { reason, error };
        this.ready.reject(new Error(error ?? reason));
        this.formatReady.reject(new Error(error ?? reason));
        void stopSession(reason, this.id);
    }

    observeConsumer() {
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
    }

    async stop(reason) {
        if (this.stopPromise) return this.stopPromise;
        this.stopped = true;
        clearInterval(this.captureTimer);
        this.ready.reject(new Error(reason));
        this.formatReady.reject(new Error(reason));
        const stoppedAt = Date.now();
        this.stopPromise = (async () => {
            let stopError;
            try {
                await this.adapter?.stop(reason);
            } catch (error) {
                stopError = String(error);
            } finally {
                const adapterSnapshot = this.adapter
                    ? { ...this.adapter.stats, ...this.adapter.exitState, stopError }
                    : undefined;
                const workletSnapshot = this.workletStats ? { ...this.workletStats } : undefined;
                resources.delete(this.id);
                if (this.window && !this.window.isDestroyed()) this.window.destroy();
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
            return resource;
        } catch (error) {
            await resource.stop("startup-failed");
            throw error;
        }
    },
    onTransition: (transition) => console.log("REAL_SESSION", JSON.stringify(transition)),
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
    metadata.dispose = () => {
        requester.removeListener("did-start-navigation", onNavigation);
        requester.removeListener("render-process-gone", onGone);
        requester.removeListener("destroyed", onDestroyed);
    };
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
        if (await controller.select(result.requestId, result.sourceId)) controller.active?.resource?.observeConsumer();
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
        const metadata = { frameTreeNodeId: frame.frameTreeNodeId };
        const id = await controller.beginReplacing(callback, metadata);
        bindRequester(request, id, metadata);
        const available = await desktopCapturer.getSources({
            types: ["window", "screen"],
            thumbnailSize: { width: 320, height: 180 },
            fetchWindowIcons: false,
        });
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
            if (await controller.select(id, selected.id)) controller.active?.resource?.observeConsumer();
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
    });

    consumerWindow = new BrowserWindow({
        show: !automated,
        width: 1000,
        height: 820,
        webPreferences: {
            preload: path.join(directory, "real-consumer-preload.cjs"),
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
        },
    });
    consumerWindow.on("closed", () => {
        consumerWindow = undefined;
        void stopSession("requester-closed");
    });
    await consumerWindow.loadFile(path.join(directory, automated ? "real-gate-consumer.html" : "real-consumer.html"));
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
                app.exit(0);
            })
            .catch((error) => {
                console.error("REAL_PRODUCER_SHUTDOWN_FAILURE", error);
                app.exit(1);
            });
    });
    app.on("window-all-closed", () => app.quit());
}

void run().catch(async (error) => {
    console.error("REAL_BOOT startup-failed", error instanceof Error ? error.message : String(error));
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
