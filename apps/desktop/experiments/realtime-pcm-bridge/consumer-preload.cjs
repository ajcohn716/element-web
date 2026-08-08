/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("diagnostics", {
    stopSession: () => ipcRenderer.invoke("pcm-consumer-stop"),
    exerciseProducer: () => ipcRenderer.invoke("pcm-consumer-exercise-producer"),
    destroyBridge: () => ipcRenderer.invoke("pcm-consumer-destroy-bridge"),
    cancelNextRequest: () => ipcRenderer.invoke("pcm-consumer-cancel-next-request"),
    sessionDiagnostics: () => ipcRenderer.invoke("pcm-consumer-session-diagnostics"),
    runtime: {
        sandboxed: process.sandboxed,
        contextIsolated: process.contextIsolated,
        nodeVersionVisibleInPreload: process.versions.node,
    },
    onStats: (callback) => ipcRenderer.on("pcm-consumer-stats", (_event, stats) => callback(stats)),
    onBridgeReady: (callback) => ipcRenderer.on("pcm-consumer-bridge-ready", (_event, details) => callback(details)),
});
