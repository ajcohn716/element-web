/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import assert from "node:assert/strict";
import test from "node:test";
import { R2ResourceLedger } from "./r2-resource-ledger.mjs";

test("R2 ledger accepts only exact owned quiescence", () => {
    const ledger = new R2ResourceLedger("unit");
    ledger.request(1);
    ledger.callback(1);
    assert.equal(ledger.assertQuiescent({ state: "Idle" }).resources, 0);
});

test("R2 ledger rejects retained owners, stale mutations, and duplicate callbacks", () => {
    const ledger = new R2ResourceLedger("unit");
    ledger.request(1);
    const release = ledger.track("timers", 7);
    assert.throws(() => ledger.assertQuiescent({ state: "Active", active: { id: 1 } }), /controller not Idle/);
    release();
    ledger.callback(1);
    assert.throws(() => ledger.callback(1), /more than once/);
});
