/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { OwnedListenerAudit } from "./owned-listener-audit.mjs";

test("owned callback is present before disposal and absent afterward", () => {
    const target = new EventEmitter();
    const audit = new OwnedListenerAudit(7);
    audit.add(target, "ended", () => {}, "requester");
    const check = audit.dispose();
    assert.equal(check.ownedBefore, 1);
    assert.equal(check.ownedAfter, 0);
    assert.equal(check.disposerCount, 1);
    assert.deepEqual(audit.assertDisposed(), check);
});

test("unrelated listener addition and removal do not affect the owned audit", () => {
    const target = new EventEmitter();
    const unrelatedBefore = () => {};
    const unrelatedAfter = () => {};
    target.on("ended", unrelatedBefore);
    const audit = new OwnedListenerAudit(8);
    audit.add(target, "ended", () => {}, "requester");
    target.removeListener("ended", unrelatedBefore);
    target.on("ended", unrelatedAfter);
    const check = audit.dispose();
    assert.equal(check.ownedAfter, 0);
    assert.equal(check.registrations[0].totalBeforeRegistration, 1);
    assert.equal(check.registrations[0].totalAfterDispose, 1);
    assert.doesNotThrow(() => audit.assertDisposed());
});

test("listener removal is idempotent but duplicate disposer invocation fails exact-once audit", () => {
    const target = new EventEmitter();
    const audit = new OwnedListenerAudit(9);
    audit.add(target, "closed", () => {}, "window");
    audit.dispose();
    const check = audit.dispose();
    assert.equal(check.ownedAfter, 0);
    assert.equal(check.disposerCount, 2);
    assert.throws(() => audit.assertDisposed(), /owner 9 listener audit failed: disposerCount=2/);
});

test("an intentionally retained callback fails with owner and event diagnostics", () => {
    const target = new EventEmitter();
    const callback = () => {};
    const audit = new OwnedListenerAudit(42);
    audit.add(target, "destroyed", callback, "requester-web-contents");
    target.on("destroyed", callback);
    const check = audit.dispose();
    assert.equal(check.ownedAfter, 1);
    assert.throws(
        () => audit.assertDisposed(),
        /owner 42 listener audit failed: disposerCount=1, retained=requester-web-contents:destroyed=1/,
    );
});
