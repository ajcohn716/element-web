/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import {
    instrumentationSource,
    isExactIsolatedPayload,
    parseElementWebUrl,
    snapshotSource,
} from "./two-party-gate.mjs";

test("two-party URL accepts only hosted http(s) URLs without embedded credentials", () => {
    assert.equal(parseElementWebUrl("https://example.test/app").hostname, "example.test");
    assert.equal(parseElementWebUrl("http://localhost:8080/").port, "8080");
    for (const value of [
        undefined,
        "not a URL",
        "file:///tmp/app",
        "javascript:alert(1)",
        "https://user:secret@example.test/",
    ]) {
        assert.throws(() => parseElementWebUrl(value));
    }
});

test("instrumentation modifies the initial request and records only sanitized fields", async () => {
    let received;
    const context = {
        navigator: {
            mediaDevices: {
                getDisplayMedia: async (constraints) => {
                    received = constraints;
                    return "stream";
                },
            },
        },
    };
    vm.createContext(context);
    assert.deepEqual(
        { ...vm.runInContext(instrumentationSource(), context) },
        { armed: true, alreadyInstalled: false },
    );
    await vm.runInContext(
        "navigator.mediaDevices.getDisplayMedia({ video: { width: 123 }, audio: { noiseSuppression: true, vendorSecret: 'redact' } })",
        context,
    );
    const snapshot = vm.runInContext(snapshotSource(), context);
    assert.equal(isExactIsolatedPayload(JSON.parse(JSON.stringify(snapshot))), true);
    assert.equal(received.video.width, 123);
    assert.equal(received.audio.vendorSecret, "redact");
    assert.equal("vendorSecret" in snapshot.audio, false);
});

test("gate fails closed before arming and for any non-exact initial payload", () => {
    assert.equal(isExactIsolatedPayload(null), false);
    assert.equal(isExactIsolatedPayload({ audioRequested: true, audio: { echoCancellation: false } }), false);
});

test("exact gate is insensitive to structured-clone property ordering", () => {
    assert.equal(
        isExactIsolatedPayload({
            audioRequested: true,
            audio: {
                channelCount: { ideal: 2 },
                echoCancellation: false,
                voiceIsolation: false,
                noiseSuppression: false,
                autoGainControl: false,
            },
        }),
        true,
    );
});
