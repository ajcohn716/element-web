/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import assert from "node:assert/strict";
import test from "node:test";

test("explicit R2 control makes the worklet close its owned input port", async () => {
    let Processor;
    // oxlint-disable-next-line typescript/no-extraneous-class -- mirrors the browser-owned worklet base class
    globalThis.AudioWorkletProcessor = class {
        constructor() {
            this.port = { postMessage: () => {}, onmessage: undefined };
        }
    };
    globalThis.registerProcessor = (_name, implementation) => {
        Processor = implementation;
    };
    await import(`./pcm-worklet.js?r2-control=${Date.now()}`);
    const processor = new Processor();
    let closeCount = 0;
    const inputPort = {
        start: () => {},
        close: () => {
            closeCount += 1;
        },
    };
    processor.port.onmessage({ data: { type: "attach-port" }, ports: [inputPort] });
    processor.port.onmessage({ data: { type: "r2-close-input-port" }, ports: [] });
    assert.equal(closeCount, 1);
    assert.equal(processor.inputPort, null);
    delete globalThis.AudioWorkletProcessor;
    delete globalThis.registerProcessor;
});
