/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

const REJECTION_GRANT = { video: { id: "", name: "" } };

export class DisplayAudioSessionController {
    #active;
    #generation = 0;
    #nextId = 1;

    constructor({ prepare, onTransition = () => {}, onStaleCompletion = () => {}, rejectionGrant = REJECTION_GRANT }) {
        this.prepare = prepare;
        this.onTransition = onTransition;
        this.onStaleCompletion = onStaleCompletion;
        this.rejectionGrant = rejectionGrant;
    }

    get active() {
        return this.#active;
    }

    get state() {
        return this.#active?.state ?? "Idle";
    }

    begin(callback, metadata = {}) {
        // Callers which can overlap requests must use beginReplacing() so the
        // previous native/bridge owner is fully gone before creating another.
        this.stop("replaced");
        const session = {
            id: this.#nextId++,
            generation: ++this.#generation,
            state: "Selecting",
            metadata,
            callback,
            callbackCount: 0,
            stopCount: 0,
            resource: undefined,
            stopPromise: undefined,
        };
        this.#active = session;
        this.#transition(session, "Selecting");
        return session.id;
    }

    async beginReplacing(callback, metadata = {}) {
        await this.stop("replaced");
        return this.begin(callback, metadata);
    }

    cancel(id, reason = "picker-cancelled") {
        const session = this.#current(id);
        if (!session) return false;
        this.#completeCallback(session, this.rejectionGrant);
        this.stop(reason, id);
        return true;
    }

    async select(id, selection) {
        const session = this.#current(id);
        if (!session || session.state !== "Selecting") return false;
        if (!selection) return this.cancel(id);
        this.#transition(session, "Preparing");
        const generation = session.generation;
        let prepared;
        try {
            prepared = await this.prepare({
                id,
                generation,
                selection,
                metadata: session.metadata,
                registerResource: (resource) => {
                    if (!this.#current(id, generation) || session.state !== "Preparing") return false;
                    if (session.resource && session.resource !== resource)
                        throw new Error("session already owns a different resource");
                    session.resource = resource;
                    return true;
                },
            });
        } catch (error) {
            if (this.#current(id, generation)) {
                session.error = String(error);
                this.#completeCallback(session, this.rejectionGrant);
                this.stop("startup-failed", id);
            }
            return false;
        }
        if (!this.#current(id, generation)) {
            this.onStaleCompletion({ id, generation, prepared });
            if (session.resource !== prepared) await prepared?.stop?.("stale-preparation");
            return false;
        }
        if (session.resource && session.resource !== prepared) {
            await prepared?.stop?.("unexpected-prepared-resource");
            await this.stop("startup-failed", id);
            return false;
        }
        session.resource = prepared;
        this.#transition(session, "Active");
        this.#completeCallback(session, prepared.grant);
        return true;
    }

    stop(reason, expectedId) {
        const session = this.#active;
        if (!session || (expectedId !== undefined && session.id !== expectedId)) return Promise.resolve(false);
        if (session.stopPromise) return session.stopPromise;
        session.stopCount += 1;
        session.stopReason = reason;
        this.#transition(session, "Stopping");
        if (session.callbackCount === 0) this.#completeCallback(session, this.rejectionGrant);
        try {
            session.metadata.dispose?.();
        } catch (error) {
            session.disposeError = String(error);
        }
        let resolveStop;
        session.stopPromise = new Promise((resolve) => {
            resolveStop = resolve;
        });
        let resourceStop;
        try {
            resourceStop = session.resource?.stop?.(reason);
        } catch (error) {
            resourceStop = Promise.reject(error);
        }
        // A synchronous resource-destroyed event can re-enter stop() and return
        // this same promise. Do not make the teardown promise await itself.
        if (resourceStop === session.stopPromise) resourceStop = undefined;
        Promise.resolve(resourceStop)
            .catch((error) => {
                session.stopError = String(error);
            })
            .then(() => {
                if (this.#active === session) this.#active = undefined;
                this.#transition(session, "Idle");
                resolveStop(true);
            });
        return session.stopPromise;
    }

    #current(id, generation) {
        const session = this.#active;
        return session?.id === id && (generation === undefined || session.generation === generation)
            ? session
            : undefined;
    }

    #completeCallback(session, grant) {
        if (session.callbackCount !== 0) return false;
        session.callbackCount += 1;
        session.callback(grant);
        return true;
    }

    #transition(session, state) {
        session.state = state;
        this.onTransition({
            id: session.id,
            generation: session.generation,
            state,
            callbackCount: session.callbackCount,
            stopCount: session.stopCount,
            stopReason: session.stopReason,
        });
    }
}
