/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

export class OneShotReady {
    #reject;
    #resolve;
    #settled = false;

    constructor() {
        this.promise = new Promise((resolve, reject) => {
            this.#resolve = resolve;
            this.#reject = reject;
        });
    }

    get settled() {
        return this.#settled;
    }

    resolve(value) {
        if (this.#settled) return false;
        this.#settled = true;
        this.#resolve(value);
        return true;
    }

    reject(error) {
        if (this.#settled) return false;
        this.#settled = true;
        this.#reject(error);
        return true;
    }
}

export async function waitForLoadAndReady(loadPromise, readyPromise) {
    await Promise.all([loadPromise, readyPromise]);
}

export class SessionResourceRegistry {
    #resources = new Map();

    get size() {
        return this.#resources.size;
    }

    register(id, resource) {
        if (this.#resources.has(id)) throw new Error(`resource ${id} is already registered`);
        this.#resources.set(id, resource);
    }

    get(id) {
        return this.#resources.get(id);
    }

    findBySender(sender) {
        return [...this.#resources.values()].find((resource) => resource.window?.webContents === sender);
    }

    delete(id, resource) {
        if (this.#resources.get(id) !== resource) return false;
        return this.#resources.delete(id);
    }

    observeExact(id, activeId) {
        const resource = this.#resources.get(id);
        if (!resource || id !== activeId) return false;
        resource.observeConsumer();
        return true;
    }
}
