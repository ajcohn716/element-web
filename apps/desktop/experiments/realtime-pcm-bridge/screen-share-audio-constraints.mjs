/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

export const ORDINARY_SCREEN_SHARE_AUDIO_CONSTRAINTS = Object.freeze({
    autoGainControl: false,
    noiseSuppression: false,
    voiceIsolation: false,
});

export function selectScreenShareAudioConstraints({ isolatedScreenShareAudio = false } = {}) {
    if (!isolatedScreenShareAudio) return { ...ORDINARY_SCREEN_SHARE_AUDIO_CONSTRAINTS };
    return {
        ...ORDINARY_SCREEN_SHARE_AUDIO_CONSTRAINTS,
        echoCancellation: false,
        channelCount: { ideal: 2 },
    };
}
