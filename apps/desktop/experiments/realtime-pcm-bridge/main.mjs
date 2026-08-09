/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { app, BrowserWindow, desktopCapturer, ipcMain, MessageChannelMain, session } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

if (process.argv.includes("--real-producer")) {
    console.error("REAL_BOOT route-entry");
    // oxlint-disable-next-line node/no-top-level-await
    await import("./real-producer-main.mjs");
} else if (process.argv.includes("--two-party")) {
    try {
        // oxlint-disable-next-line node/no-top-level-await
        await import("./two-party-main.mjs");
    } catch {
        console.error(
            "Two-party mode requires a valid hosted URL. Usage: electron main.mjs --two-party --element-url=https://YOUR-TEST-ELEMENT-WEB/",
        );
        // No windows or resources exist on this configuration-error path.
        // oxlint-disable-next-line node/no-process-exit
        process.exit(2);
    }
} else if (process.argv.includes("--lifecycle")) {
    // oxlint-disable-next-line node/no-top-level-await
    await import("./lifecycle-main.mjs");
} else {
    const experimentDirectory = path.dirname(fileURLToPath(import.meta.url));
    const SAMPLE_RATE = 48_000;
    const CHUNK_FRAMES = 480;
    const MAX_IN_FLIGHT = 20;
    const automated = process.argv.includes("--automated");
    const fidelity = process.argv.includes("--fidelity");
    const enableLocalEcho = process.argv.includes("--enable-local-echo");
    const soakArgument = process.argv.find((argument) => argument.startsWith("--soak-ms="));
    const soakMilliseconds = soakArgument ? Number(soakArgument.split("=")[1]) : 120_000;
    let consumerWindow;
    let activeSession;
    let nextSessionId = 1;
    let cancelNextRequest = false;

    class BridgeSession {
        constructor() {
            this.id = nextSessionId++;
            this.sequence = 0;
            this.nextFrame = 0;
            this.inFlight = 0;
            this.startedAt = performance.now();
            this.timer = null;
            this.starting = false;
            this.latestStats = null;
            this.readyPromise = new Promise((resolve, reject) => {
                this.resolveReady = resolve;
                this.rejectReady = reject;
            });
            this.window = new BrowserWindow({
                show: false,
                webPreferences: {
                    preload: path.join(experimentDirectory, "bridge-preload.cjs"),
                    sandbox: true,
                    nodeIntegration: false,
                    contextIsolation: true,
                    // A hidden realtime audio renderer must not have its timers/worklet throttled.
                    backgroundThrottling: false,
                },
            });
            this.window.on("closed", () => {
                this.window = null;
                this.stop();
            });
        }

        async start() {
            if (!this.window || this.stopped) throw new Error("bridge session stopped before startup");
            this.starting = true;
            try {
                await this.window.loadFile(path.join(experimentDirectory, "bridge.html"));
                await this.readyPromise;
            } finally {
                this.starting = false;
            }
            this.startedAt = performance.now();
            this.timer = setInterval(() => this.pump(), 5);
            this.pump();
            await new Promise((resolve) => setTimeout(resolve, 120));
        }

        attachPort() {
            if (!this.window || this.port) return;
            const { port1, port2 } = new MessageChannelMain();
            this.port = port1;
            this.port.on("message", (event) => {
                if (event.data?.type === "ack") this.inFlight = Math.max(0, this.inFlight - 1);
            });
            this.port.start();
            this.window.webContents.postMessage("pcm-port", this.id, [port2]);
        }

        bridgeReady(details) {
            this.bridgeDetails = details;
            consumerWindow?.webContents.send("pcm-consumer-bridge-ready", details);
            this.resolveReady(details);
        }

        pump() {
            if (!this.port) return;
            const dueFrames = Math.floor(((performance.now() - this.startedAt) * SAMPLE_RATE) / 1000);
            while (this.nextFrame + CHUNK_FRAMES <= dueFrames && this.inFlight < MAX_IN_FLIGHT) {
                const pcm = new Int16Array(CHUNK_FRAMES * 2);
                for (let frame = 0; frame < CHUNK_FRAMES; frame += 1) {
                    const left = Math.round(
                        Math.sin((2 * Math.PI * 733 * (this.nextFrame + frame)) / SAMPLE_RATE) * 0.2 * 32767,
                    );
                    const right = fidelity
                        ? Math.round(
                              Math.sin((2 * Math.PI * 997 * (this.nextFrame + frame)) / SAMPLE_RATE) * 0.2 * 32767,
                          )
                        : left;
                    pcm[frame * 2] = left;
                    pcm[frame * 2 + 1] = right;
                }
                this.port.postMessage({
                    type: "pcm",
                    sequence: this.sequence,
                    startFrame: this.nextFrame,
                    pcm: pcm.buffer,
                });
                this.sequence += 1;
                this.nextFrame += CHUNK_FRAMES;
                this.inFlight += 1;
            }
        }

        stop() {
            if (this.stopped) return;
            this.stopped = true;
            if (this.starting) this.rejectReady(new Error("bridge session stopped"));
            clearInterval(this.timer);
            this.port?.postMessage({ type: "stop" });
            this.port?.close();
            this.port = null;
            if (this.window && !this.window.isDestroyed()) this.window.destroy();
            this.window = null;
        }
    }

    app.enableSandbox();

    ipcMain.on("pcm-bridge-request-port", (event) => {
        if (activeSession?.window?.webContents === event.sender) activeSession.attachPort();
    });
    ipcMain.on("pcm-bridge-ready", (event, details) => {
        if (activeSession?.window?.webContents === event.sender) activeSession.bridgeReady(details);
    });
    ipcMain.on("pcm-bridge-stats", (event, stats) => {
        if (activeSession?.window?.webContents !== event.sender) return;
        activeSession.latestStats = stats;
        consumerWindow?.webContents.send("pcm-consumer-stats", { ...stats, producerInFlight: activeSession.inFlight });
    });
    ipcMain.on("pcm-bridge-failed", (event, error) => {
        if (activeSession?.window?.webContents === event.sender) activeSession.rejectReady(new Error(error));
    });
    ipcMain.handle("pcm-consumer-stop", () => {
        activeSession?.stop();
        activeSession = null;
    });
    ipcMain.handle("pcm-consumer-exercise-producer", async () => {
        if (!activeSession || activeSession.stopped) throw new Error("no active producer");
        clearInterval(activeSession.timer);
        activeSession.timer = null;
        await new Promise((resolve) => setTimeout(resolve, 300));
        activeSession.timer = setInterval(() => activeSession?.pump(), 5);
        activeSession.pump();
    });
    ipcMain.handle("pcm-consumer-destroy-bridge", () => {
        activeSession?.stop();
    });
    ipcMain.handle("pcm-consumer-cancel-next-request", () => {
        cancelNextRequest = true;
    });
    ipcMain.handle("pcm-consumer-session-diagnostics", () => ({
        activeSession: Boolean(activeSession && !activeSession.stopped),
        bridgeWindows: BrowserWindow.getAllWindows().filter((window) => window !== consumerWindow).length,
        allWindows: BrowserWindow.getAllWindows().length,
    }));

    app.whenReady().then(() => {
        session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
            console.log("display media request", {
                audioRequested: request.audioRequested,
                videoRequested: request.videoRequested,
            });
            activeSession?.stop();
            activeSession = new BridgeSession();
            if (cancelNextRequest) {
                cancelNextRequest = false;
                activeSession.stop();
                activeSession = null;
                // oxlint-disable-next-line promise/no-callback-in-promise
                callback({ video: { id: "", name: "" } });
                return;
            }
            try {
                await activeSession.start();
                if (!activeSession.window || activeSession.window.isDestroyed())
                    throw new Error("bridge frame was destroyed before capture grant");
                const screens = await desktopCapturer.getSources({ types: ["screen"] });
                if (!screens[0]) throw new Error("no diagnostic screen source available");
                // oxlint-disable-next-line promise/no-callback-in-promise
                callback({ video: screens[0], audio: activeSession.window.webContents.mainFrame, enableLocalEcho });
            } catch (error) {
                console.error("bridge startup failed", error);
                activeSession?.stop();
                activeSession = null;
                // oxlint-disable-next-line promise/no-callback-in-promise
                callback({ video: { id: "", name: "" } });
            }
        });

        consumerWindow = new BrowserWindow({
            width: 960,
            height: 760,
            webPreferences: {
                preload: path.join(experimentDirectory, "consumer-preload.cjs"),
                sandbox: true,
                nodeIntegration: false,
                contextIsolation: true,
            },
        });
        consumerWindow.on("closed", () => {
            activeSession?.stop();
            activeSession = null;
            consumerWindow = null;
        });
        void consumerWindow.loadFile(path.join(experimentDirectory, "consumer.html")).then(async () => {
            if (!automated && !fidelity) return;
            try {
                const results = await consumerWindow.webContents.executeJavaScript(
                    fidelity
                        ? "window.runtimeTest.runFidelity()"
                        : `window.runtimeTest.run(${JSON.stringify(soakMilliseconds)})`,
                );
                console.log(fidelity ? "FIDELITY_RESULTS" : "AUTOMATED_RESULTS", JSON.stringify(results));
                app.exit(0);
            } catch (error) {
                console.error("AUTOMATED_FAILURE", error);
                app.exit(1);
            }
        });
    });

    app.on("window-all-closed", () => app.quit());
}
