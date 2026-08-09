/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import assert from "node:assert/strict";
import test from "node:test";
import { DisplayAudioSessionController } from "./session-controller.mjs";

const deferred = () => {
    let resolve;
    const promise = new Promise((value) => (resolve = value));
    return { promise, resolve };
};

test("cancel before selection invokes callback once without preparing", async () => {
    let preparations = 0;
    const callbacks = [];
    const controller = new DisplayAudioSessionController({
        prepare: async () => {
            preparations += 1;
        },
    });
    const id = controller.begin((grant) => callbacks.push(grant));
    assert.equal(controller.cancel(id), true);
    await controller.active?.stopPromise;
    assert.equal(preparations, 0);
    assert.equal(callbacks.length, 1);
    assert.equal(controller.state, "Idle");
});

test("replacement stops one owner and blocks stale preparation", async () => {
    const firstPreparation = deferred();
    const stopped = [];
    const callbacks = [[], []];
    const controller = new DisplayAudioSessionController({
        prepare: async ({ id }) => {
            if (id === 1) return firstPreparation.promise;
            return { grant: { audio: `audio-${id}` }, stop: (reason) => stopped.push({ id, reason }) };
        },
    });
    const first = controller.begin((grant) => callbacks[0].push(grant));
    const selecting = controller.select(first, "first");
    const second = controller.begin((grant) => callbacks[1].push(grant));
    await controller.select(second, "second");
    firstPreparation.resolve({ grant: { audio: "stale" }, stop: (reason) => stopped.push({ id: first, reason }) });
    await selecting;
    assert.equal(callbacks[0].length, 1);
    assert.equal(callbacks[1].length, 1);
    assert.equal(callbacks[1][0].audio, "audio-2");
    assert.deepEqual(stopped, [{ id: first, reason: "stale-preparation" }]);
    assert.equal(controller.active.id, second);
});

test("active teardown is idempotent", async () => {
    let resourceStops = 0;
    const transitions = [];
    const controller = new DisplayAudioSessionController({
        prepare: async () => ({ grant: { audio: "frame" }, stop: () => (resourceStops += 1) }),
        onTransition: (transition) => transitions.push(transition),
    });
    const id = controller.begin(() => {});
    await controller.select(id, "source");
    const firstStop = controller.stop("consumer-stopped", id);
    const secondStop = controller.stop("duplicate", id);
    await Promise.all([firstStop, secondStop]);
    assert.equal(resourceStops, 1);
    assert.equal(transitions.filter((item) => item.state === "Stopping").length, 1);
    assert.equal(transitions.find((item) => item.state === "Stopping").stopReason, "consumer-stopped");
    assert.equal(controller.state, "Idle");
});

test("preparation arms ownership monitoring before Active and callback grant", async () => {
    const events = [];
    const controller = new DisplayAudioSessionController({
        prepare: async () => {
            events.push("bridge-ready");
            events.push("monitor-armed");
            return { grant: { audio: "frame" }, stop: () => {} };
        },
        onTransition: ({ state }) => {
            if (state === "Active") events.push("active");
        },
    });
    const id = controller.begin(() => events.push("callback-granted"));
    await controller.select(id, "source");
    assert.deepEqual(events, ["bridge-ready", "monitor-armed", "active", "callback-granted"]);
    await controller.stop("cleanup");
});

test("resource teardown re-entry cannot create a second stop transition", async () => {
    const transitions = [];
    const owner = {};
    const controller = new DisplayAudioSessionController({
        prepare: async ({ id }) => ({
            grant: { audio: "frame" },
            stop: () => owner.controller.stop("resource-destroyed", id),
        }),
        onTransition: (transition) => transitions.push(transition),
    });
    owner.controller = controller;
    const id = controller.begin(() => {});
    await controller.select(id, "source");
    await controller.stop("application-shutdown", id);
    assert.equal(transitions.filter((item) => item.state === "Stopping").length, 1);
    assert.equal(transitions.find((item) => item.state === "Stopping").stopReason, "application-shutdown");
});

test("owner listener disposer runs once on ordinary stop, cancel, and replacement", async () => {
    const disposed = [];
    const controller = new DisplayAudioSessionController({
        prepare: async ({ id }) => ({ grant: { audio: `frame-${id}` } }),
    });
    const begin = () => {
        const metadata = { dispose: () => disposed.push(metadata.id) };
        metadata.id = controller.begin(() => {}, metadata);
        return metadata.id;
    };
    const ordinary = begin();
    await controller.select(ordinary, "source");
    await controller.stop("consumer-stopped", ordinary);
    const cancelled = begin();
    controller.cancel(cancelled);
    await controller.active?.stopPromise;
    const replaced = begin();
    const replacement = begin();
    await controller.active?.stopPromise;
    await controller.stop("test-cleanup", replacement);
    assert.deepEqual(disposed, [ordinary, cancelled, replaced, replacement]);
});

test("beginReplacing waits for the prior resource teardown before publishing a new owner", async () => {
    const teardown = deferred();
    const controller = new DisplayAudioSessionController({
        prepare: async ({ id }) => ({
            grant: { audio: `frame-${id}` },
            stop: () => (id === 1 ? teardown.promise : undefined),
        }),
    });
    const first = controller.begin(() => {});
    await controller.select(first, "first");
    let replacementResolved = false;
    const replacement = controller
        .beginReplacing(() => {})
        .then((id) => {
            replacementResolved = true;
            return id;
        });
    await Promise.resolve();
    assert.equal(replacementResolved, false);
    teardown.resolve();
    const second = await replacement;
    assert.equal(second, 2);
    assert.equal(controller.active.id, second);
    await controller.stop("cleanup");
});

test("a preparing resource is centrally owned and stopped exactly once", async () => {
    const preparation = deferred();
    let stops = 0;
    const controller = new DisplayAudioSessionController({
        prepare: async ({ registerResource }) => {
            const resource = { stop: () => (stops += 1) };
            assert.equal(registerResource(resource), true);
            await preparation.promise;
            return resource;
        },
    });
    const id = controller.begin(() => {});
    const selecting = controller.select(id, "source");
    await Promise.resolve();
    await controller.stop("requester-destroyed", id);
    preparation.resolve();
    assert.equal(await selecting, false);
    assert.equal(stops, 1);
    assert.equal(controller.state, "Idle");
});

test("stopping a preparing owner releases its barrier without starting a producer", async () => {
    const entered = deferred();
    const released = deferred();
    let producers = 0;
    let stops = 0;
    const controller = new DisplayAudioSessionController({
        prepare: async ({ registerResource }) => {
            const resource = {
                stop: () => {
                    stops += 1;
                    released.resolve();
                },
            };
            assert.equal(registerResource(resource), true);
            entered.resolve();
            await released.promise;
            if (controller.state === "Preparing") producers += 1;
            throw new Error("preparing owner stopped");
        },
    });
    const id = controller.begin(() => {});
    const selecting = controller.select(id, "source");
    await entered.promise;
    await controller.stop("replaced", id);
    assert.equal(await selecting, false);
    assert.equal(stops, 1);
    assert.equal(producers, 0);
    assert.equal(controller.state, "Idle");
});

test("stale completion is counted once without callback or replacement mutation", async () => {
    const preparation = deferred();
    const callbacks = [0, 0];
    const stale = [];
    let staleStops = 0;
    const controller = new DisplayAudioSessionController({
        prepare: async ({ id }) =>
            id === 1 ? preparation.promise : { grant: { audio: "replacement" }, stop: () => {} },
        onStaleCompletion: (details) => stale.push({ id: details.id, generation: details.generation }),
    });
    const first = controller.begin(() => (callbacks[0] += 1));
    const firstSelection = controller.select(first, "first");
    const second = await controller.beginReplacing(() => (callbacks[1] += 1));
    await controller.select(second, "second");
    preparation.resolve({ grant: { audio: "stale" }, stop: () => (staleStops += 1) });
    await firstSelection;
    assert.deepEqual(stale, [{ id: first, generation: 1 }]);
    assert.equal(staleStops, 1);
    assert.deepEqual(callbacks, [1, 1]);
    assert.equal(controller.active.id, second);
    assert.equal(controller.active.resource.grant.audio, "replacement");
    await controller.stop("cleanup");
});
