/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import assert from "node:assert/strict";
import test from "node:test";
import {
    ORDINARY_SCREEN_SHARE_AUDIO_CONSTRAINTS,
    selectScreenShareAudioConstraints,
} from "./screen-share-audio-constraints.mjs";

test("ordinary capture is byte-for-byte equivalent to the established payload", () => {
    const selected = selectScreenShareAudioConstraints();
    assert.deepEqual(selected, {
        autoGainControl: false,
        noiseSuppression: false,
        voiceIsolation: false,
    });
    assert.equal("echoCancellation" in selected, false);
    assert.equal("channelCount" in selected, false);
});

test("isolated capture adds only the proven initial high-fidelity constraints", () => {
    assert.deepEqual(selectScreenShareAudioConstraints({ isolatedScreenShareAudio: true }), {
        autoGainControl: false,
        noiseSuppression: false,
        voiceIsolation: false,
        echoCancellation: false,
        channelCount: { ideal: 2 },
    });
});

test("callers receive a fresh payload and cannot mutate the ordinary baseline", () => {
    const selected = selectScreenShareAudioConstraints();
    selected.autoGainControl = true;
    assert.equal(ORDINARY_SCREEN_SHARE_AUDIO_CONSTRAINTS.autoGainControl, false);
    assert.deepEqual(selectScreenShareAudioConstraints(), ORDINARY_SCREEN_SHARE_AUDIO_CONSTRAINTS);
});
