/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { app, BrowserWindow, desktopCapturer, ipcMain, MessageChannelMain, session, webContents } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { AwaitedQuitFinalizer } from "./awaited-quit-finalizer.mjs";
import { OwnedListenerAudit } from "./owned-listener-audit.mjs";
import { DisplayAudioSessionController } from "./session-controller.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_RATE = 48_000;
const CHUNK_FRAMES = 480;
const POLL_MS = 50;
const FALSE_DEBOUNCE_SAMPLES = 2;
const START_DEADLINE_MS = 3_000;
const TEARDOWN_DEADLINE_MS = 1_000;
const records = [];
const resources = new Set();
const listenerDisposalChecks = [];
let preparationCount = 0;
let consumerWindow;
let selectionMode = "select";
let currentResource;
let shutdownRequested = false;

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const assert = (condition, message) => {
    if (!condition) throw new Error(`Lifecycle assertion failed: ${message}`);
};
const waitFor = async (predicate, message, timeout = 5_000) => {
    const started = performance.now();
    while (!predicate()) {
        if (performance.now() - started > timeout) throw new Error(`Timed out: ${message}`);
        await delay(25);
    }
};

class SyntheticBridgeResource {
    constructor(id, onTerminal) {
        this.id = id;
        this.onTerminal = onTerminal;
        this.sequence = 0;
        this.nextFrame = 0;
        this.inFlight = 0;
        this.acks = 0;
        this.workletStats = 0;
        this.mediaEvents = [];
        this.captureSamples = [];
        this.startedAt = performance.now();
        this.ready = new Promise((resolve, reject) => {
            this.resolveReady = resolve;
            this.rejectReady = reject;
        });
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
        resources.add(this);
        this.window.webContents.on("media-started-playing", () => this.mediaEvents.push("media-started-playing"));
        this.window.webContents.on("media-paused", () => this.mediaEvents.push("media-paused"));
        this.window.webContents.on("audio-state-changed", (event) =>
            this.mediaEvents.push(`audio-state:${Boolean(event.audible)}`),
        );
        this.window.webContents.on("render-process-gone", (_event, details) =>
            this.onTerminal(`bridge-renderer-${details.reason}`),
        );
        this.window.webContents.on("destroyed", () => this.onTerminal("bridge-destroyed"));
        this.window.on("closed", () => this.onTerminal("bridge-closed"));
    }

    async start() {
        await this.window.loadFile(path.join(directory, "bridge.html"));
        await this.ready;
        this.startedAt = performance.now();
        this.timer = setInterval(() => this.pump(), 5);
        this.pump();
        await delay(120);
        this.prebufferFrames = this.nextFrame;
    }

    attachPort() {
        if (this.port || this.stopped) return;
        const { port1, port2 } = new MessageChannelMain();
        this.port = port1;
        this.port.on("message", (event) => {
            if (event.data?.type === "ack") {
                this.inFlight = Math.max(0, this.inFlight - 1);
                this.acks += 1;
            }
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
                const sample = Math.round(
                    Math.sin((2 * Math.PI * 733 * (this.nextFrame + frame)) / SAMPLE_RATE) * 6553,
                );
                pcm[frame * 2] = sample;
                pcm[frame * 2 + 1] = sample;
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

    startCaptureObservation() {
        const started = performance.now();
        let observed = false;
        let falseCount = 0;
        this.captureTimer = setInterval(() => {
            if (this.stopped || !this.window || this.window.isDestroyed()) return;
            const captured = this.window.webContents.isBeingCaptured();
            this.captureSamples.push({ elapsedMs: Math.round(performance.now() - started), captured });
            if (captured) {
                observed = true;
                this.captureObserved = true;
                falseCount = 0;
            } else if (observed) {
                falseCount += 1;
                if (falseCount >= FALSE_DEBOUNCE_SAMPLES) this.onTerminal("consumer-stopped");
            } else if (performance.now() - started > START_DEADLINE_MS) {
                this.onTerminal("capture-never-started");
            }
        }, POLL_MS);
    }

    snapshot() {
        return {
            id: this.id,
            acks: this.acks,
            workletStats: this.workletStats,
            mediaEvents: [...this.mediaEvents],
            captureSamples: [...this.captureSamples],
            captureObserved: Boolean(this.captureObserved),
            prebufferFrames: this.prebufferFrames,
            stopped: Boolean(this.stopped),
        };
    }

    stop(reason) {
        if (this.stopped) return;
        this.stopped = true;
        this.stopReason = reason;
        clearInterval(this.timer);
        clearInterval(this.captureTimer);
        this.timer = undefined;
        this.captureTimer = undefined;
        this.port?.postMessage({ type: "stop" });
        this.port?.close();
        this.port = undefined;
        const window = this.window;
        this.window = undefined;
        if (window && !window.isDestroyed()) window.destroy();
        resources.delete(this);
    }
}

const transitions = [];
const controller = new DisplayAudioSessionController({
    onTransition: (transition) => transitions.push({ ...transition, at: performance.now() }),
    prepare: async ({ id }) => {
        preparationCount += 1;
        const resource = new SyntheticBridgeResource(id, (reason) => void controller.stop(reason, id));
        currentResource = resource;
        await resource.start();
        const screens = await desktopCapturer.getSources({ types: ["screen"] });
        if (!screens[0]) throw new Error("no diagnostic screen source");
        return {
            grant: { video: screens[0], audio: resource.window.webContents.mainFrame, enableLocalEcho: false },
            stop: (reason) => resource.stop(reason),
            resource,
        };
    },
});

ipcMain.on("pcm-bridge-request-port", (event) => {
    if (currentResource?.window?.webContents === event.sender) currentResource.attachPort();
});
ipcMain.on("pcm-bridge-ready", (event, details) => {
    if (currentResource?.window?.webContents === event.sender) currentResource.resolveReady(details);
});
ipcMain.on("pcm-bridge-stats", (event) => {
    if (currentResource?.window?.webContents === event.sender) currentResource.workletStats += 1;
});
ipcMain.on("pcm-bridge-failed", (event, error) => {
    if (currentResource?.window?.webContents === event.sender) currentResource.rejectReady(new Error(error));
});

const bindRequester = (request, id, metadata) => {
    const requester = webContents.fromFrame(request.frame);
    if (!requester) {
        void controller.stop("requester-destroyed", id);
        return;
    }
    const stop = (reason) => void controller.stop(reason, id);
    const onNavigation = (details) => {
        if (!details.isSameDocument && details.frame?.frameTreeNodeId === metadata.frameTreeNodeId)
            stop("requester-navigated");
    };
    const onGone = (_event, details) => stop(`requester-renderer-${details.reason}`);
    const onDestroyed = () => stop("requester-destroyed");
    const requesterWindow = BrowserWindow.fromWebContents(requester);
    const onClosed = () => stop("requester-closed");
    const listenerAudit = new OwnedListenerAudit(id);
    listenerAudit.add(requester, "did-start-navigation", onNavigation, "requester-web-contents");
    listenerAudit.add(requester, "render-process-gone", onGone, "requester-web-contents");
    listenerAudit.add(requester, "destroyed", onDestroyed, "requester-web-contents");
    if (requesterWindow) listenerAudit.add(requesterWindow, "closed", onClosed, "requester-window");
    metadata.dispose = () => {
        listenerDisposalChecks.push({ audit: listenerAudit, check: listenerAudit.dispose() });
    };
};

const installDisplayHandler = () => {
    session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
        const frame = request.frame;
        if (!frame || frame.detached || frame.isDestroyed()) {
            callback({ video: { id: "", name: "" } });
            return;
        }
        const metadata = {
            frameTreeNodeId: frame.frameTreeNodeId,
            processId: frame.processId,
            routingId: frame.routingId,
        };
        const id = controller.begin(callback, metadata);
        bindRequester(request, id, metadata);
        queueMicrotask(async () => {
            if (selectionMode === "cancel") {
                controller.cancel(id);
                return;
            }
            if (await controller.select(id, "diagnostic-screen")) currentResource?.startCaptureObservation();
        });
    });
};

const createConsumer = async () => {
    consumerWindow = new BrowserWindow({
        show: false,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    const file = path.join(directory, "lifecycle-consumer.html");
    try {
        await consumerWindow.loadFile(file);
    } catch (error) {
        if (error?.code !== "ERR_FAILED" || consumerWindow.isDestroyed()) throw error;
        await delay(100);
        await consumerWindow.loadFile(file);
    }
    return consumerWindow;
};
const execute = (source) => consumerWindow.webContents.executeJavaScript(source);
const startCapture = async (key) => {
    const result = await execute(`window.lifecycleTest.capture(${JSON.stringify(key)})`);
    assert(result.ok, `${key} getDisplayMedia: ${result.error}`);
    await waitFor(() => currentResource?.captureObserved, `${key} capture observed true`);
    return currentResource;
};
const finishScenario = async (name, resource, expectedReason) => {
    const stopStart = performance.now();
    await waitFor(() => controller.state === "Idle", `${name} teardown`, TEARDOWN_DEADLINE_MS);
    const result = resource.snapshot();
    result.teardownMs = Math.round(performance.now() - stopStart);
    result.stopReason = resource.stopReason;
    assert(result.stopReason === expectedReason, `${name} reason ${result.stopReason}, expected ${expectedReason}`);
    assert(result.teardownMs <= TEARDOWN_DEADLINE_MS, `${name} teardown bound`);
    assert(!resource.port && !resource.timer && !resource.captureTimer, `${name} resource leak`);
    records.push({ name, ...result });
};

const run = async () => {
    installDisplayHandler();
    console.log("LIFECYCLE_STAGE", "create initial consumer");
    await createConsumer();

    console.log("LIFECYCLE_STAGE", "explicit stop");
    let resource = await startCapture("explicit-stop");
    await execute('window.lifecycleTest.stopAll("explicit-stop")');
    await finishScenario("explicit all-track stop", resource, "consumer-stopped");

    console.log("LIFECYCLE_STAGE", "audio stop");
    resource = await startCapture("audio-stop");
    await delay(1_050);
    const candidateSignalsAtStop = {
        acks: resource.acks,
        workletStats: resource.workletStats,
        mediaEvents: [...resource.mediaEvents],
    };
    await execute('window.lifecycleTest.stopAudio("audio-stop")');
    const audioStopState = await execute('window.lifecycleTest.state("audio-stop")');
    assert(
        audioStopState.tracks.some((track) => track.kind === "video" && track.state === "live"),
        "video remains live",
    );
    await delay(60);
    const candidateSignalsAfterStop = {
        acks: resource.acks,
        workletStats: resource.workletStats,
        mediaEvents: [...resource.mediaEvents],
    };
    assert(
        candidateSignalsAfterStop.acks > candidateSignalsAtStop.acks,
        "port acknowledgements continue after track.stop",
    );
    await finishScenario("direct audio track stop", resource, "consumer-stopped");
    records[records.length - 1].candidateSignalsAtStop = candidateSignalsAtStop;
    records[records.length - 1].candidateSignalsAfterStop = candidateSignalsAfterStop;

    console.log("LIFECYCLE_STAGE", "navigation");
    resource = await startCapture("navigate");
    const navigatedConsumer = consumerWindow;
    void consumerWindow.webContents.loadURL("data:text/html,navigated").catch(() => {});
    await finishScenario("requester navigation", resource, "requester-navigated");
    console.log("LIFECYCLE_STAGE", "create after navigation");
    await createConsumer();
    navigatedConsumer.destroy();

    console.log("LIFECYCLE_STAGE", "requester crash");
    resource = await startCapture("requester-crash");
    const crashProcessIds = {
        requester: consumerWindow.webContents.getOSProcessId(),
        bridge: resource.window.webContents.getOSProcessId(),
    };
    assert(crashProcessIds.requester !== crashProcessIds.bridge, "requester and bridge crash isolation");
    consumerWindow.webContents.forcefullyCrashRenderer();
    await finishScenario("requester renderer crash", resource, "requester-renderer-crashed");
    const crashedConsumer = consumerWindow;
    console.log("LIFECYCLE_STAGE", "create after requester crash");
    await createConsumer();
    crashedConsumer.destroy();

    console.log("LIFECYCLE_STAGE", "requester close");
    resource = await startCapture("requester-close");
    const closingConsumer = consumerWindow;
    console.log("LIFECYCLE_STAGE", "create before requester close");
    await createConsumer();
    closingConsumer.close();
    await finishScenario("requester window close", resource, "requester-destroyed");

    console.log("LIFECYCLE_STAGE", "bridge close");
    resource = await startCapture("bridge-close");
    resource.window.close();
    await finishScenario("bridge window close", resource, "bridge-destroyed");

    console.log("LIFECYCLE_STAGE", "bridge crash");
    resource = await startCapture("bridge-crash");
    resource.window.webContents.forcefullyCrashRenderer();
    await finishScenario("bridge renderer crash", resource, "bridge-renderer-crashed");

    console.log("LIFECYCLE_STAGE", "replacement");
    const first = await startCapture("replacement-first");
    const secondPromise = execute('window.lifecycleTest.capture("replacement-second")');
    await waitFor(() => controller.active?.id !== first.id && controller.state === "Active", "replacement active");
    const secondResult = await secondPromise;
    assert(secondResult.ok, "replacement second grant");
    const firstState = await execute('window.lifecycleTest.state("replacement-first")');
    assert(
        firstState.tracks.some((track) => track.kind === "audio" && track.state === "ended"),
        "replacement ends first audio",
    );
    assert(first.stopReason === "replaced", "replacement reason");
    records.push({ name: "active replacement first", ...first.snapshot(), stopReason: first.stopReason, firstState });
    resource = currentResource;
    await waitFor(() => resource.captureObserved, "replacement second capture observed true");
    await execute('window.lifecycleTest.stopAudio("replacement-second")');
    await finishScenario("active replacement second", resource, "consumer-stopped");

    console.log("LIFECYCLE_STAGE", "picker cancel");
    selectionMode = "cancel";
    const preparationCountBeforeCancel = preparationCount;
    const resourceCountBeforeCancel = resources.size;
    const windowCountBeforeCancel = BrowserWindow.getAllWindows().length;
    const cancellation = await execute('window.lifecycleTest.capture("cancel")');
    await waitFor(() => controller.state === "Idle", "picker cancellation idle");
    assert(!cancellation.ok && cancellation.error.startsWith("NotReadableError:"), "picker cancellation rejects");
    assert(preparationCount === preparationCountBeforeCancel, "picker cancellation performs zero preparation");
    assert(resources.size === resourceCountBeforeCancel && resources.size === 0, "picker cancellation resources zero");
    assert(BrowserWindow.getAllWindows().length === windowCountBeforeCancel, "picker cancellation creates no window");
    const cancellationStop = transitions.findLast(
        (transition) => transition.state === "Stopping" && transition.stopReason === "picker-cancelled",
    );
    assert(cancellationStop?.callbackCount === 1, "picker cancellation callback exactly once");
    selectionMode = "select";
    records.push({
        name: "picker cancellation",
        cancellation,
        callbackCount: cancellationStop.callbackCount,
        preparationsCreated: preparationCount - preparationCountBeforeCancel,
        resourcesAfter: resources.size,
        windowsCreated: BrowserWindow.getAllWindows().length - windowCountBeforeCancel,
    });

    console.log("LIFECYCLE_STAGE", "application quit");
    resource = await startCapture("application-quit");
    records.push({ name: "application quit active", resource });
    shutdownRequested = true;
    app.quit();
};

app.enableSandbox();
const stopWithinDeadline = async () => {
    let timeout;
    try {
        await Promise.race([
            controller.stop("application-shutdown"),
            new Promise((_, reject) => {
                timeout = setTimeout(
                    () => reject(new Error("application shutdown teardown deadline exceeded")),
                    TEARDOWN_DEADLINE_MS,
                );
            }),
        ]);
    } finally {
        clearTimeout(timeout);
    }
};

const finalizeShutdown = async (eventName) => {
    if (!currentResource) return;
    const resource = currentResource;
    await stopWithinDeadline();
    assert(controller.state === "Idle", "controller idle after application shutdown");
    const result = resource.snapshot();
    result.stopReason = resource.stopReason;
    records[records.length - 1] = { name: "application quit active", ...result };
    const stopping = transitions.filter((item) => item.state === "Stopping");
    const byId = new Map();
    for (const item of stopping) byId.set(item.id, (byId.get(item.id) ?? 0) + 1);
    const ownerIds = new Set(transitions.filter((item) => item.state === "Selecting").map((item) => item.id));
    assert(
        byId.size === ownerIds.size && [...ownerIds].every((id) => byId.get(id) === 1),
        "exactly one teardown per owner",
    );
    assert(listenerDisposalChecks.length === ownerIds.size, "exactly one listener audit per owner");
    for (const { audit } of listenerDisposalChecks) audit.assertDisposed();
    assert(resources.size === 0, "shutdown bridge resources zero");
    assert(!resource.port && !resource.timer && !resource.captureTimer, "shutdown resource leak");
    console.log(
        "LIFECYCLE_RESULTS",
        JSON.stringify({
            pollMs: POLL_MS,
            falseDebounceSamples: FALSE_DEBOUNCE_SAMPLES,
            teardownDeadlineMs: TEARDOWN_DEADLINE_MS,
            transitions,
            listenerDisposalChecks: listenerDisposalChecks.map(({ check }) => check),
            records,
            shutdownEvent: eventName,
        }),
    );
};
const quitFinalizer = new AwaitedQuitFinalizer({
    finalize: () => finalizeShutdown("before-quit"),
    exit: (code) => app.exit(code),
    onFailure: (error) => console.error("LIFECYCLE_SHUTDOWN_FAILURE", error),
});
app.on("before-quit", (event) => {
    if (!shutdownRequested) return;
    quitFinalizer.handle(event);
});

app.whenReady().then(() =>
    run().catch((error) => {
        console.error("LIFECYCLE_FAILURE", error);
        app.exit(1);
    }),
);
