/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

const countCallback = (target, event, callback) =>
    target.listeners(event).filter((listener) => listener === callback).length;

export class OwnedListenerAudit {
    #disposeCount = 0;
    #lastCheck;
    #registrations = [];

    constructor(ownerId) {
        this.ownerId = ownerId;
    }

    add(target, event, callback, label) {
        const totalBeforeRegistration = target.listenerCount(event);
        target.on(event, callback);
        this.#registrations.push({ target, event, callback, label, totalBeforeRegistration });
    }

    dispose() {
        this.#disposeCount += 1;
        const before = this.#inspect();
        if (this.#disposeCount === 1) {
            for (const { target, event, callback } of this.#registrations) target.removeListener(event, callback);
        }
        const after = this.#inspect();
        this.#lastCheck = {
            ownerId: this.ownerId,
            disposerCount: this.#disposeCount,
            ownedBefore: before.reduce((sum, item) => sum + item.owned, 0),
            ownedAfter: after.reduce((sum, item) => sum + item.owned, 0),
            registrations: after.map((item, index) => ({
                label: item.label,
                event: item.event,
                ownedBefore: before[index].owned,
                ownedAfter: item.owned,
                totalBeforeRegistration: item.totalBeforeRegistration,
                totalBeforeDispose: before[index].total,
                totalAfterDispose: item.total,
            })),
        };
        return this.#lastCheck;
    }

    assertDisposed() {
        const current = this.#inspect();
        const check = this.#lastCheck
            ? {
                  ...this.#lastCheck,
                  ownedAfter: current.reduce((sum, item) => sum + item.owned, 0),
                  registrations: this.#lastCheck.registrations.map((item, index) => ({
                      ...item,
                      ownedAfter: current[index].owned,
                      totalAfterDispose: current[index].total,
                  })),
              }
            : {
                  ownerId: this.ownerId,
                  disposerCount: this.#disposeCount,
                  ownedBefore: undefined,
                  ownedAfter: current.reduce((sum, item) => sum + item.owned, 0),
                  registrations: current.map((item) => ({
                      label: item.label,
                      event: item.event,
                      ownedAfter: item.owned,
                      totalBeforeRegistration: item.totalBeforeRegistration,
                      totalAfterDispose: item.total,
                  })),
              };
        const retained = check.registrations.filter((item) => item.ownedAfter !== 0);
        if (check.disposerCount !== 1 || retained.length !== 0) {
            const details =
                retained.map((item) => `${item.label}:${item.event}=${item.ownedAfter}`).join(", ") || "none";
            throw new Error(
                `owner ${this.ownerId} listener audit failed: disposerCount=${check.disposerCount}, retained=${details}`,
            );
        }
        return check;
    }

    #inspect() {
        return this.#registrations.map(({ target, event, callback, label, totalBeforeRegistration }) => ({
            label,
            event,
            owned: countCallback(target, event, callback),
            total: target.listenerCount(event),
            totalBeforeRegistration,
        }));
    }
}
