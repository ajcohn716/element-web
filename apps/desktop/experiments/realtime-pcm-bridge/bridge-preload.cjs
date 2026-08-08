/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

const { contextBridge, ipcRenderer } = require("electron");

ipcRenderer.on("pcm-port", (event, sessionId) => {
    if (event.ports.length !== 1) return;
    window.postMessage({ type: "pcm-bridge-port", sessionId }, "*", event.ports);
});

contextBridge.exposeInMainWorld("bridgeHost", {
    requestPort: () => ipcRenderer.send("pcm-bridge-request-port"),
    ready: (details) => ipcRenderer.send("pcm-bridge-ready", details),
    report: (stats) => ipcRenderer.send("pcm-bridge-stats", stats),
    failed: (error) => ipcRenderer.send("pcm-bridge-failed", error),
});
