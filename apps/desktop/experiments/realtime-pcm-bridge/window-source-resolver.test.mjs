/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import assert from "node:assert/strict";
import test from "node:test";
import { parseWindowSourceId, resolveWindowSource } from "./window-source-resolver.mjs";

test("parses current Electron window source IDs", () => assert.equal(parseWindowSourceId("window:460388:0"), 460388));
test("rejects screens and malformed IDs", () => {
    for (const id of ["screen:0:0", "window:0:0", "window:12:1", "window:title:0"])
        assert.throws(() => parseWindowSourceId(id));
});
test("resolver returns only identity data and rejects stale handles", async () => {
    const resolved = await resolveWindowSource("tool", "window:99:0", (_exe, _args, _options, callback) =>
        callback(null, "pid=123\nexecutable=x.exe\n"),
    );
    assert.deepEqual(resolved, { sourceId: "window:99:0", hwnd: 99, pid: 123 });
    await assert.rejects(
        resolveWindowSource("tool", "window:99:0", (_exe, _args, _options, callback) =>
            callback(new Error("gone"), ""),
        ),
        /stale/,
    );
});
