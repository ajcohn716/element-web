/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import assert from "node:assert/strict";
import test from "node:test";
import { DisplayAudioSessionController } from "./session-controller.mjs";
import { hostedTeardownOracle, prepareHostedPicker, validatePickerResult } from "./real-two-party-gate.mjs";

test("picker accepts only its exact sender, request, and offered source", () => {
    const expectedSender = {};
    const base = { expectedSender, requestId: 7, sourceIds: new Set(["window:1:0"]) };
    assert.deepEqual(
        validatePickerResult({ ...base, sender: expectedSender, result: { requestId: 7, sourceId: "window:1:0" } }),
        {
            accepted: true,
            sourceId: "window:1:0",
        },
    );
    assert.equal(
        validatePickerResult({ ...base, sender: {}, result: { requestId: 7, sourceId: "window:1:0" } }).accepted,
        false,
    );
    assert.equal(
        validatePickerResult({ ...base, sender: expectedSender, result: { requestId: 8, sourceId: "window:1:0" } })
            .accepted,
        false,
    );
    assert.equal(
        validatePickerResult({ ...base, sender: expectedSender, result: { requestId: 7, sourceId: "window:2:0" } })
            .accepted,
        false,
    );
});

test("picker cancellation is an exact accepted null selection", () => {
    const sender = {};
    assert.deepEqual(
        validatePickerResult({
            sender,
            expectedSender: sender,
            result: { requestId: 3, sourceId: null },
            requestId: 3,
            sourceIds: new Set(),
        }),
        { accepted: true, sourceId: null },
    );
});

for (const failedStep of ["enumerate", "create-load-send-open"]) {
    test(`hosted picker ${failedStep} failure rejects once and returns Idle without an async rejection`, async () => {
        const callbacks = [];
        const controller = new DisplayAudioSessionController({ prepare: async () => ({}) });
        const requestId = controller.begin((grant) => callbacks.push(grant));
        const result = await prepareHostedPicker({
            requestId,
            enumerateSources: async () => {
                if (failedStep === "enumerate") throw new Error("enumeration failed");
                return [];
            },
            openPicker: async () => {
                throw new Error("picker failed");
            },
            isCurrent: (id) => controller.active?.id === id,
            onFailure: (id, reason) => controller.cancel(id, reason),
        });
        await controller.active?.stopPromise;
        assert.equal(result, false);
        assert.equal(callbacks.length, 1);
        assert.equal(controller.state, "Idle");
    });
}

test("hosted teardown oracle requires every owned count to return to zero", () => {
    const clean = {
        state: "Idle",
        callbackCount: 1,
        producerProcesses: 0,
        messagePorts: 0,
        bridgeWindows: 0,
        captureTimers: 0,
        adapterTimers: 0,
        pickerWindows: 0,
        ownedListeners: 0,
        resources: 0,
        teardownMilliseconds: 104,
    };
    assert.equal(hostedTeardownOracle(clean).passed, true);
    for (const key of [
        "producerProcesses",
        "messagePorts",
        "bridgeWindows",
        "captureTimers",
        "adapterTimers",
        "pickerWindows",
        "ownedListeners",
        "resources",
    ]) {
        assert.equal(hostedTeardownOracle({ ...clean, [key]: 1 }).passed, false, key);
    }
    assert.equal(hostedTeardownOracle({ ...clean, callbackCount: 2 }).passed, false);
    assert.equal(hostedTeardownOracle({ ...clean, state: "Stopping" }).passed, false);
});
