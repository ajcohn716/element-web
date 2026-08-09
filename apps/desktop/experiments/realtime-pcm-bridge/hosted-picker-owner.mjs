/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

export class HostedPickerOwner {
    #disposed = false;

    constructor({ requestId, sourceIds, window, onCancel, ownership }) {
        this.requestId = requestId;
        this.sourceIds = sourceIds;
        this.window = window;
        this.onCancel = onCancel;
        this.releaseWindow = ownership.acquire("pickerWindows");
        this.releaseListener = ownership.acquire("ownedListeners");
        this.onClosed = () => this.#dispose("picker-closed", true, false);
        window.once("closed", this.onClosed);
    }

    close(reason, { cancel = false } = {}) {
        return this.#dispose(reason, cancel, true);
    }

    #dispose(reason, cancel, destroy) {
        if (this.#disposed) return false;
        this.#disposed = true;
        this.window.removeListener("closed", this.onClosed);
        this.releaseListener();
        if (destroy && !this.window.isDestroyed()) this.window.destroy();
        if (this.window.isDestroyed()) this.releaseWindow();
        if (cancel) this.onCancel(this.requestId, reason);
        return true;
    }
}
