/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { HostedOwnershipLedger } from "./hosted-ownership.mjs";
import { HostedPickerOwner } from "./hosted-picker-owner.mjs";

class FakeWindow extends EventEmitter {
    destroyed = false;

    destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
        this.emit("closed");
    }

    isDestroyed() {
        return this.destroyed;
    }
}

for (const reason of ["requester-destroyed", "application-shutdown", "replaced"]) {
    test(`${reason} closes the exact picker without a second cancellation`, () => {
        const ownership = new HostedOwnershipLedger();
        const cancellations = [];
        const window = new FakeWindow();
        const owner = new HostedPickerOwner({
            requestId: 9,
            sourceIds: new Set(),
            window,
            ownership,
            onCancel: (...arguments_) => cancellations.push(arguments_),
        });
        assert.equal(owner.close(reason), true);
        assert.equal(owner.close(reason), false);
        assert.equal(window.isDestroyed(), true);
        assert.deepEqual(cancellations, []);
        assert.equal(ownership.snapshot().pickerWindows, 0);
        assert.equal(ownership.snapshot().ownedListeners, 0);
    });
}

test("user close cancels exactly once and releases picker ownership", () => {
    const ownership = new HostedOwnershipLedger();
    const cancellations = [];
    const window = new FakeWindow();
    const owner = new HostedPickerOwner({
        requestId: 4,
        sourceIds: new Set(),
        window,
        ownership,
        onCancel: (...arguments_) => cancellations.push(arguments_),
    });
    window.destroy();
    window.emit("closed");
    assert.equal(owner.close("again"), false);
    assert.deepEqual(cancellations, [[4, "picker-closed"]]);
    assert.equal(ownership.snapshot().pickerWindows, 0);
    assert.equal(ownership.snapshot().ownedListeners, 0);
});
