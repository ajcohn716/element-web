/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

export class AwaitedQuitFinalizer {
    #finalizationPromise;

    constructor({ finalize, exit, onFailure = () => {} }) {
        this.finalize = finalize;
        this.exit = exit;
        this.onFailure = onFailure;
    }

    handle(event) {
        event.preventDefault();
        if (this.#finalizationPromise) return this.#finalizationPromise;
        this.#finalizationPromise = Promise.resolve().then(this.finalize);
        void this.#finalizationPromise.then(
            () => this.exit(0),
            (error) => {
                this.onFailure(error);
                this.exit(1);
            },
        );
        return this.#finalizationPromise;
    }
}
