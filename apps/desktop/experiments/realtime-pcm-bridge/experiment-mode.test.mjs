/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import assert from "node:assert/strict";
import test from "node:test";
import { selectExperimentMode } from "./experiment-mode.mjs";

test("real two-party routing requires and composes real producer mode", () => {
    assert.equal(selectExperimentMode(["--real-producer", "--real-two-party"]), "real-two-party");
    assert.throws(() => selectExperimentMode(["--real-two-party"]), /requires --real-producer/);
});

test("ordinary experiment routes remain unchanged", () => {
    assert.equal(selectExperimentMode(["--r2-failures"]), "r2-failures");
    assert.equal(selectExperimentMode(["--real-producer"]), "real-producer");
    assert.equal(selectExperimentMode(["--two-party"]), "two-party");
    assert.equal(selectExperimentMode(["--lifecycle"]), "lifecycle");
    assert.equal(selectExperimentMode([]), "default");
});
