/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("realPickerHost", {
    onOpen: (callback) => ipcRenderer.once("real-two-party-picker-open", (_event, request) => callback(request)),
    choose: (requestId, sourceId) => ipcRenderer.send("real-two-party-picker-result", { requestId, sourceId }),
});
