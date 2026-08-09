/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import assert from "node:assert/strict";
import test from "node:test";
import { BridgeStartupGate } from "./bridge-startup-gate.mjs";

test("about:blank attachment is ignored until startup and accepted exactly once afterward", () => {
    const gate = new BridgeStartupGate();
    assert.equal(gate.claimAttachment(), false);
    assert.equal(gate.start(), true);
    assert.equal(gate.claimAttachment(), true);
    assert.equal(gate.claimAttachment(), false);
});

test("stop before startup is clean, idempotent, and permanently blocks attachment", () => {
    const gate = new BridgeStartupGate();
    gate.stop();
    gate.stop();
    assert.equal(gate.start(), false);
    assert.equal(gate.claimAttachment(), false);
});
