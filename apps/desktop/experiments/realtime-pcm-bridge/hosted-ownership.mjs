/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

const OWNER_KEYS = Object.freeze([
    "producerProcesses",
    "messagePorts",
    "bridgeWindows",
    "captureTimers",
    "pickerWindows",
    "ownedListeners",
]);

export class HostedOwnershipLedger {
    #counts = Object.fromEntries(OWNER_KEYS.map((key) => [key, 0]));

    acquire(kind) {
        if (!OWNER_KEYS.includes(kind)) throw new Error(`unknown hosted owner: ${kind}`);
        this.#counts[kind] += 1;
        let released = false;
        return () => {
            if (released) return false;
            released = true;
            this.#counts[kind] -= 1;
            if (this.#counts[kind] < 0) throw new Error(`negative hosted owner count: ${kind}`);
            return true;
        };
    }

    snapshot() {
        return { ...this.#counts };
    }
}
