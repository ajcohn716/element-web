/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { AwaitedQuitFinalizer } from "./awaited-quit-finalizer.mjs";

const deferred = () => {
    let resolve;
    const promise = new Promise((value) => (resolve = value));
    return { promise, resolve };
};

test("repeated quit while stop is pending is prevented and finalized exactly once", async () => {
    const stop = deferred();
    const prevented = [];
    const exits = [];
    const handled = [];
    let finalizations = 0;
    const finalizer = new AwaitedQuitFinalizer({
        finalize: () => {
            finalizations += 1;
            return stop.promise;
        },
        exit: (code) => exits.push(code),
    });
    const fakeApp = new EventEmitter();
    fakeApp.on("before-quit", (event) => handled.push(finalizer.handle(event)));
    fakeApp.quit = (label) => fakeApp.emit("before-quit", { preventDefault: () => prevented.push(label) });
    fakeApp.quit("first");
    fakeApp.quit("second");
    await Promise.resolve();
    assert.deepEqual(prevented, ["first", "second"]);
    assert.equal(handled[0], handled[1]);
    assert.equal(finalizations, 1);
    assert.deepEqual(exits, []);
    stop.resolve();
    await handled[0];
    await Promise.resolve();
    assert.deepEqual(exits, [0]);
});

test("repeated quit reports one failed finalization and requests one failure exit", async () => {
    const failure = new Error("deadline");
    const failures = [];
    const exits = [];
    let finalizations = 0;
    const finalizer = new AwaitedQuitFinalizer({
        finalize: async () => {
            finalizations += 1;
            throw failure;
        },
        exit: (code) => exits.push(code),
        onFailure: (error) => failures.push(error),
    });
    const first = finalizer.handle({ preventDefault: () => {} });
    const second = finalizer.handle({ preventDefault: () => {} });
    await assert.rejects(first, failure);
    await assert.rejects(second, failure);
    await Promise.resolve();
    assert.equal(finalizations, 1);
    assert.deepEqual(failures, [failure]);
    assert.deepEqual(exits, [1]);
});
