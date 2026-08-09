/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { selectScreenShareAudioConstraints } from "./screen-share-audio-constraints.mjs";

export const SNAPSHOT_KEY = "__elementPcmBridgeDisplayRequest";
export const ISOLATED_AUDIO_CONSTRAINTS = Object.freeze(
    selectScreenShareAudioConstraints({ isolatedScreenShareAudio: true }),
);

export function parseElementWebUrl(argument) {
    if (!argument) throw new Error("--element-url=<http(s) URL> is required in two-party mode");
    const url = new URL(argument);
    if (url.protocol !== "https:" && url.protocol !== "http:")
        throw new Error("Element Web URL must use http or https");
    if (!url.hostname || url.username || url.password)
        throw new Error("Element Web URL must have a host and no credentials");
    return url;
}

export function sanitizeAudioConstraints(audio) {
    if (!audio || typeof audio !== "object") return null;
    return {
        autoGainControl: audio.autoGainControl,
        noiseSuppression: audio.noiseSuppression,
        voiceIsolation: audio.voiceIsolation,
        echoCancellation: audio.echoCancellation,
        channelCount:
            audio.channelCount && typeof audio.channelCount === "object"
                ? { ideal: audio.channelCount.ideal }
                : audio.channelCount,
    };
}

export function isExactIsolatedPayload(snapshot) {
    const audio = snapshot?.audio;
    if (snapshot?.audioRequested !== true || !audio || typeof audio !== "object") return false;
    const keys = Object.keys(audio).sort();
    const expectedKeys = Object.keys(ISOLATED_AUDIO_CONSTRAINTS).sort();
    return (
        JSON.stringify(keys) === JSON.stringify(expectedKeys) &&
        audio.autoGainControl === false &&
        audio.noiseSuppression === false &&
        audio.voiceIsolation === false &&
        audio.echoCancellation === false &&
        audio.channelCount &&
        typeof audio.channelCount === "object" &&
        Object.keys(audio.channelCount).length === 1 &&
        audio.channelCount.ideal === 2
    );
}

// Runs in the requesting frame's main world. Keep this function self-contained.
export function installDisplayMediaInstrumentation(isolatedAudioConstraints, snapshotKey) {
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.getDisplayMedia) return { armed: false, reason: "getDisplayMedia unavailable" };
    if (globalThis[snapshotKey]?.installed) return { armed: true, alreadyInstalled: true };
    const original = mediaDevices.getDisplayMedia.bind(mediaDevices);
    Object.defineProperty(globalThis, snapshotKey, {
        configurable: true,
        value: { installed: true, request: null },
    });
    mediaDevices.getDisplayMedia = (constraints = {}) => {
        const audio = constraints.audio === true ? {} : constraints.audio;
        const mergedAudio = audio && typeof audio === "object" ? { ...audio, ...isolatedAudioConstraints } : audio;
        const merged = { ...constraints, audio: mergedAudio };
        globalThis[snapshotKey].request = {
            audioRequested: Boolean(merged.audio),
            audio: mergedAudio
                ? {
                      autoGainControl: mergedAudio.autoGainControl,
                      noiseSuppression: mergedAudio.noiseSuppression,
                      voiceIsolation: mergedAudio.voiceIsolation,
                      echoCancellation: mergedAudio.echoCancellation,
                      channelCount:
                          mergedAudio.channelCount && typeof mergedAudio.channelCount === "object"
                              ? { ideal: mergedAudio.channelCount.ideal }
                              : mergedAudio.channelCount,
                  }
                : null,
        };
        return original(merged);
    };
    return { armed: true, alreadyInstalled: false };
}

export function instrumentationSource() {
    return `(${installDisplayMediaInstrumentation.toString()})(${JSON.stringify(ISOLATED_AUDIO_CONSTRAINTS)}, ${JSON.stringify(SNAPSHOT_KEY)})`;
}

export function snapshotSource() {
    return `globalThis[${JSON.stringify(SNAPSHOT_KEY)}]?.request ?? null`;
}
