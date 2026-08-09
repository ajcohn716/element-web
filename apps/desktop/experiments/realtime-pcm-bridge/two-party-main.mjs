/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { app, BrowserWindow, desktopCapturer, ipcMain, MessageChannelMain, session, webContents } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { DisplayAudioSessionController } from "./session-controller.mjs";
import { OneShotReady, SessionResourceRegistry, waitForLoadAndReady } from "./session-resource-registry.mjs";
import {
    instrumentationSource,
    isExactIsolatedPayload,
    parseElementWebUrl,
    snapshotSource,
} from "./two-party-gate.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const elementUrlArgument = process.argv.find((argument) => argument.startsWith("--element-url="));
const elementUrl = parseElementWebUrl(elementUrlArgument?.slice("--element-url=".length));
const automated = process.argv.includes("--automated");
const SAMPLE_RATE = 48_000;
const CHUNK_FRAMES = 480;
const POLL_MS = 50;
const resourceRegistry = new SessionResourceRegistry();
let elementWindow;
let stoppingForQuit = false;

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

class TwoPartyBridgeResource {
    constructor(id, onTerminal) {
        this.id = id;
        this.onTerminal = onTerminal;
        this.sequence = 0;
        this.nextFrame = 0;
        this.inFlight = 0;
        this.startedAt = performance.now();
        this.readySignal = new OneShotReady();
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
        resourceRegistry.register(id, this);
        this.window.webContents.on("render-process-gone", (_event, details) =>
            this.terminal(`bridge-renderer-${details.reason}`),
        );
        this.window.webContents.on("destroyed", () => this.terminal("bridge-destroyed"));
        this.window.on("closed", () => this.terminal("bridge-closed"));
    }

    async start() {
        await waitForLoadAndReady(this.window.loadFile(path.join(directory, "bridge.html")), this.readySignal.promise);
        this.startedAt = performance.now();
        this.timer = setInterval(() => this.pump(), 5);
        this.pump();
        await delay(120);
    }

    attachPort() {
        if (this.port || this.stopped) return;
        const { port1, port2 } = new MessageChannelMain();
        this.port = port1;
        this.port.on("message", (event) => {
            if (event.data?.type === "ack") this.inFlight = Math.max(0, this.inFlight - 1);
        });
        this.port.start();
        this.window.webContents.postMessage("pcm-port", this.id, [port2]);
    }

    pump() {
        if (!this.port || this.stopped) return;
        const due = Math.floor(((performance.now() - this.startedAt) * SAMPLE_RATE) / 1000);
        while (this.nextFrame + CHUNK_FRAMES <= due && this.inFlight < 20) {
            const pcm = new Int16Array(CHUNK_FRAMES * 2);
            for (let frame = 0; frame < CHUNK_FRAMES; frame += 1) {
                const absoluteFrame = this.nextFrame + frame;
                const cuePhase = Math.floor(absoluteFrame / (SAMPLE_RATE * 1.5)) % 2;
                pcm[frame * 2] =
                    cuePhase === 0 ? Math.round(Math.sin((2 * Math.PI * 733 * absoluteFrame) / SAMPLE_RATE) * 6553) : 0;
                pcm[frame * 2 + 1] =
                    cuePhase === 1 ? Math.round(Math.sin((2 * Math.PI * 997 * absoluteFrame) / SAMPLE_RATE) * 6553) : 0;
            }
            this.port.postMessage({
                type: "pcm",
                sequence: this.sequence++,
                startFrame: this.nextFrame,
                pcm: pcm.buffer,
            });
            this.nextFrame += CHUNK_FRAMES;
            this.inFlight += 1;
        }
    }

    observeConsumer() {
        const started = performance.now();
        let observed = false;
        let falseSamples = 0;
        this.captureTimer = setInterval(() => {
            if (this.stopped || !this.window || this.window.isDestroyed()) return;
            const captured = this.window.webContents.isBeingCaptured();
            if (captured) {
                observed = true;
                falseSamples = 0;
            } else if (observed && ++falseSamples >= 2) {
                this.terminal("consumer-stopped");
            } else if (!observed && performance.now() - started > 3_000) {
                this.terminal("capture-never-started");
            }
        }, POLL_MS);
    }

    terminal(reason) {
        if (this.terminalReported) return;
        this.terminalReported = true;
        this.stop(reason);
        this.onTerminal(reason);
    }

    stop(reason) {
        if (this.stopped) return;
        this.stopped = true;
        this.readySignal.reject(new Error(`bridge stopped before readiness: ${reason}`));
        clearInterval(this.timer);
        clearInterval(this.captureTimer);
        this.port?.postMessage({ type: "stop" });
        this.port?.close();
        this.port = undefined;
        const window = this.window;
        this.window = undefined;
        if (window && !window.isDestroyed()) window.destroy();
        resourceRegistry.delete(this.id, this);
        console.log("TWO_PARTY_SESSION_STOPPED", { reason, resources: resourceRegistry.size });
        if (automated && reason === "consumer-stopped" && resourceRegistry.size === 0) setTimeout(() => app.quit(), 0);
    }
}

const controller = new DisplayAudioSessionController({
    onTransition: (transition) => console.log("TWO_PARTY_SESSION", transition),
    prepare: async ({ id }) => {
        const resource = new TwoPartyBridgeResource(id, (reason) => void controller.stop(reason, id));
        try {
            await resource.start();
            const screens = await desktopCapturer.getSources({ types: ["screen"] });
            if (!screens[0]) throw new Error("no diagnostic screen source");
            return {
                grant: { video: screens[0], audio: resource.window.webContents.mainFrame, enableLocalEcho: false },
                stop: (reason) => resource.stop(reason),
            };
        } catch (error) {
            resource.stop("startup-failed");
            throw error;
        }
    },
});

const bindRequester = (request, id, metadata) => {
    const requester = webContents.fromFrame(request.frame);
    if (!requester) return void controller.stop("requester-destroyed", id);
    const stop = (reason) => void controller.stop(reason, id);
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
};

const armFrame = async (frame) => {
    if (!frame || frame.detached || frame.isDestroyed()) return false;
    try {
        const result = await frame.executeJavaScript(instrumentationSource());
        return result?.armed === true;
    } catch {
        return false;
    }
};

const armCurrentFrames = async () => {
    const frames = elementWindow?.webContents.mainFrame?.framesInSubtree ?? [];
    const results = await Promise.all(frames.map((frame) => armFrame(frame)));
    const armed = results.filter(Boolean).length;
    console.log("TWO_PARTY_INSTRUMENTATION_ARMED", { armedFrames: armed });
};

app.enableSandbox();

ipcMain.on("pcm-bridge-request-port", (event) => {
    resourceRegistry.findBySender(event.sender)?.attachPort();
});
ipcMain.on("pcm-bridge-ready", (event, details) => {
    resourceRegistry.findBySender(event.sender)?.readySignal.resolve(details);
});
ipcMain.on("pcm-bridge-failed", (event, error) => {
    resourceRegistry.findBySender(event.sender)?.readySignal.reject(new Error(error));
});

const run = async () => {
    await app.whenReady();

    session.defaultSession.setPermissionRequestHandler((requestingWebContents, permission, callback) => {
        callback(requestingWebContents === elementWindow?.webContents && permission === "media");
    });
    session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
        const frame = request.frame;
        if (!frame || frame.detached || frame.isDestroyed()) return callback({ video: { id: "", name: "" } });
        let snapshot;
        try {
            snapshot = await frame.executeJavaScript(snapshotSource());
        } catch {
            snapshot = null;
        }
        if (!isExactIsolatedPayload(snapshot)) {
            console.error("TWO_PARTY_REQUEST_REJECTED", {
                reason: "initial constraints not armed or not exact",
                observed: snapshot,
            });
            callback({ video: { id: "", name: "" } });
            return;
        }
        console.log("TWO_PARTY_REQUEST_ACCEPTED", snapshot);
        const metadata = { frameTreeNodeId: frame.frameTreeNodeId };
        const id = controller.begin(callback, metadata);
        bindRequester(request, id, metadata);
        const selected = await controller.select(id, { diagnosticScreen: true });
        if (selected) resourceRegistry.observeExact(id, controller.active?.id);
    });

    elementWindow = new BrowserWindow({
        width: 1280,
        height: 900,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    elementWindow.webContents.on("frame-created", (_event, details) => {
        const frame = details.frame;
        if (frame) frame.once("dom-ready", () => void armFrame(frame));
    });
    elementWindow.webContents.on("did-finish-load", () => void armCurrentFrames());
    elementWindow.webContents.on(
        "render-process-gone",
        (_event, details) => void controller.stop(`requester-renderer-${details.reason}`),
    );
    elementWindow.webContents.on("destroyed", () => void controller.stop("requester-destroyed"));
    elementWindow.on("closed", () => {
        void controller.stop("requester-closed");
        elementWindow = undefined;
    });
    await elementWindow.loadURL(elementUrl.href);
    if (automated) {
        setTimeout(() => {
            if (controller.state !== "Idle" || resourceRegistry.size !== 0) {
                console.error("TWO_PARTY_AUTOMATED_TIMEOUT", {
                    resources: resourceRegistry.size,
                    state: controller.state,
                });
                void controller.stop("automated-timeout").finally(() => app.exit(1));
            }
        }, 10_000);
    }

    app.on("before-quit", (event) => {
        if (stoppingForQuit) return;
        event.preventDefault();
        stoppingForQuit = true;
        void controller.stop("application-shutdown").finally(() => app.exit(resourceRegistry.size === 0 ? 0 : 1));
    });
    app.on("window-all-closed", () => app.quit());
};

void run().catch(() => {
    console.error("TWO_PARTY_STARTUP_FAILED", { reason: "window load or setup failed" });
    app.exit(1);
});
