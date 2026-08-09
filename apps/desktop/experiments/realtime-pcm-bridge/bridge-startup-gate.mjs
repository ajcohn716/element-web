/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

export class BridgeStartupGate {
    #attached = false;
    #state = "dormant";

    start() {
        if (this.#state === "stopped") return false;
        this.#state = "started";
        return true;
    }

    claimAttachment() {
        if (this.#state !== "started" || this.#attached) return false;
        this.#attached = true;
        return true;
    }

    stop() {
        this.#state = "stopped";
    }
}
