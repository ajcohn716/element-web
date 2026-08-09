/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

const streams = new Map();
const ended = new Map();

window.lifecycleTest = {
    async capture(key) {
        try {
            const stream = await navigator.mediaDevices.getDisplayMedia({
                video: true,
                audio: { autoGainControl: false, noiseSuppression: false, voiceIsolation: false },
            });
            streams.set(key, stream);
            ended.set(key, []);
            for (const track of stream.getTracks()) {
                track.addEventListener("ended", () => ended.get(key)?.push(track.kind));
            }
            return {
                ok: true,
                tracks: stream.getTracks().map((track) => ({ kind: track.kind, state: track.readyState })),
            };
        } catch (error) {
            return { ok: false, error: `${error.name}: ${error.message}` };
        }
    },
    stopAll(key) {
        streams
            .get(key)
            ?.getTracks()
            .forEach((track) => track.stop());
    },
    stopAudio(key) {
        streams
            .get(key)
            ?.getAudioTracks()
            .forEach((track) => track.stop());
    },
    state(key) {
        return {
            tracks:
                streams
                    .get(key)
                    ?.getTracks()
                    .map((track) => ({ kind: track.kind, state: track.readyState })) ?? [],
            endedEvents: ended.get(key) ?? [],
        };
    },
};
