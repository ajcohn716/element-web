/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { DisplayAudioSessionController } from "./session-controller.mjs";
import { OneShotReady, SessionResourceRegistry, waitForLoadAndReady } from "./session-resource-registry.mjs";

test("pre-ready termination settles preparation and leaves one callback, Idle, and zero resources", async () => {
    const registry = new SessionResourceRegistry();
    const unhandled = [];
    const rejectionWarnings = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    const onWarning = (warning) => {
        if (warning.name === "PromiseRejectionHandledWarning") rejectionWarnings.push(warning);
    };
    process.on("unhandledRejection", onUnhandled);
    process.on("warning", onWarning);
    let resource;
    const controller = new DisplayAudioSessionController({
        prepare: async ({ id }) => {
            const ready = new OneShotReady();
            const load = new Promise(() => {});
            resource = {
                ready,
                stop: () => {
                    ready.reject(new Error("pre-ready bridge terminated"));
                    registry.delete(id, resource);
                },
            };
            registry.register(id, resource);
            try {
                await waitForLoadAndReady(load, ready.promise);
                return { grant: { audio: true }, stop: resource.stop };
            } catch (error) {
                resource.stop();
                throw error;
            }
        },
    });
    const callbacks = [];
    const id = controller.begin((grant) => callbacks.push(grant));
    const selection = controller.select(id, {});
    await nextTurn();
    resource.stop();
    assert.equal(await selection, false);
    await nextTurn();
    await controller.stop("test-complete");
    assert.equal(resource.ready.settled, true);
    assert.equal(callbacks.length, 1);
    assert.equal(controller.state, "Idle");
    assert.equal(registry.size, 0);
    assert.deepEqual(unhandled, []);
    assert.deepEqual(rejectionWarnings, []);
    process.removeListener("unhandledRejection", onUnhandled);
    process.removeListener("warning", onWarning);
});

test("replacement monitoring uses the exact accepted owner", () => {
    const registry = new SessionResourceRegistry();
    const observations = [];
    const oldResource = { observeConsumer: () => observations.push("old") };
    const newResource = { observeConsumer: () => observations.push("new") };
    registry.register(1, oldResource);
    registry.register(2, newResource);
    assert.equal(registry.observeExact(1, 2), false);
    assert.equal(registry.observeExact(2, 2), true);
    assert.deepEqual(observations, ["new"]);
    assert.equal(registry.delete(1, newResource), false);
    assert.equal(registry.delete(1, oldResource), true);
    assert.equal(registry.size, 1);
});
