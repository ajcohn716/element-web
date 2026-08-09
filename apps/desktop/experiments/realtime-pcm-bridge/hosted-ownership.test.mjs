/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import assert from "node:assert/strict";
import test from "node:test";
import { HostedOwnershipLedger } from "./hosted-ownership.mjs";

test("hosted ownership leases decrement only once on explicit disposal", () => {
    const ledger = new HostedOwnershipLedger();
    const releasePort = ledger.acquire("messagePorts");
    const releaseWindow = ledger.acquire("pickerWindows");
    assert.deepEqual(ledger.snapshot(), {
        producerProcesses: 0,
        messagePorts: 1,
        bridgeWindows: 0,
        captureTimers: 0,
        pickerWindows: 1,
        ownedListeners: 0,
    });
    assert.equal(releasePort(), true);
    assert.equal(releasePort(), false);
    assert.equal(releaseWindow(), true);
    assert.equal(releaseWindow(), false);
    assert.deepEqual(ledger.snapshot(), {
        producerProcesses: 0,
        messagePorts: 0,
        bridgeWindows: 0,
        captureTimers: 0,
        pickerWindows: 0,
        ownedListeners: 0,
    });
});

test("hosted ownership rejects unknown owner categories", () => {
    assert.throws(() => new HostedOwnershipLedger().acquire("total-electron-listeners"), /unknown hosted owner/);
});
