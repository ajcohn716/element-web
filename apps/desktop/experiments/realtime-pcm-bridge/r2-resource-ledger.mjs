/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

export class R2ResourceLedger {
    constructor(caseName) {
        this.caseName = caseName;
        this.requests = new Map();
        this.resources = new Set();
        this.producerPids = new Set();
        this.producerPidHistory = [];
        this.ports = new Set();
        this.windows = new Set();
        this.timers = new Set();
        this.listeners = new Set();
        this.barriers = new Set();
        this.transitions = [];
        this.staleMutations = 0;
        this.staleCompletions = 0;
        this.staleObservations = [];
        this.startedAt = performance.now();
        this.maxTeardownMilliseconds = 0;
        this.maxOwned = new Map();
    }

    request(id) {
        if (this.requests.has(id)) throw new Error(`duplicate request ${id}`);
        const record = { id, callbackCount: 0 };
        this.requests.set(id, record);
        return record;
    }

    callback(id, result) {
        const record = this.requests.get(id);
        if (!record) throw new Error(`unknown callback request ${id}`);
        record.callbackCount += 1;
        record.callbackResult = result;
        if (record.callbackCount > 1) throw new Error(`request ${id} callback completed more than once`);
    }

    transition(value) {
        this.transitions.push(value);
    }

    track(setName, value) {
        this[setName].add(value);
        this.maxOwned.set(setName, Math.max(this.maxOwned.get(setName) ?? 0, this[setName].size));
        return () => this[setName].delete(value);
    }

    trackProducer(pid) {
        this.producerPidHistory.push(pid);
        return this.track("producerPids", pid);
    }

    snapshot(controller) {
        return {
            case: this.caseName,
            controllerState: controller.state,
            activeSession: controller.active?.id ?? null,
            callbacks: [...this.requests.values()].map(({ id, callbackCount, callbackResult }) => ({
                id,
                callbackCount,
                callbackResult,
            })),
            producerPidHistory: [...this.producerPidHistory],
            maxResources: this.maxOwned.get("resources") ?? 0,
            maxProducerProcesses: this.maxOwned.get("producerPids") ?? 0,
            maxBridgeWindows: this.maxOwned.get("windows") ?? 0,
            maxMessagePorts: this.maxOwned.get("ports") ?? 0,
            resources: this.resources.size,
            producerProcesses: this.producerPids.size,
            messagePorts: this.ports.size,
            bridgeWindows: this.windows.size,
            ownedTimers: this.timers.size,
            ownedListeners: this.listeners.size,
            barriers: this.barriers.size,
            staleMutations: this.staleMutations,
            staleCompletions: this.staleCompletions,
            staleObservations: [...this.staleObservations],
            maxTeardownMilliseconds: this.maxTeardownMilliseconds,
        };
    }

    assertQuiescent(controller) {
        const result = this.snapshot(controller);
        const failures = [];
        if (result.controllerState !== "Idle" || result.activeSession !== null) failures.push("controller not Idle");
        for (const request of result.callbacks) {
            if (request.callbackCount !== 1)
                failures.push(`request ${request.id} callback count ${request.callbackCount}`);
        }
        for (const key of [
            "resources",
            "producerProcesses",
            "messagePorts",
            "bridgeWindows",
            "ownedTimers",
            "ownedListeners",
            "barriers",
            "staleMutations",
        ]) {
            if (result[key] !== 0) failures.push(`${key}=${result[key]}`);
        }
        if (result.maxTeardownMilliseconds > 1_500)
            failures.push(`teardown ${result.maxTeardownMilliseconds}ms exceeded 1500ms`);
        if (failures.length) throw new Error(`R2 quiescence failed: ${failures.join(", ")}`);
        return result;
    }
}
