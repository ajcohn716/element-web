/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("realProducerHost", {
    onPicker: (callback) => ipcRenderer.on("real-picker-open", (_event, request) => callback(request)),
    choose: (requestId, sourceId) => ipcRenderer.send("real-picker-result", { requestId, sourceId }),
    diagnostics: () => ipcRenderer.invoke("real-session-diagnostics"),
});

