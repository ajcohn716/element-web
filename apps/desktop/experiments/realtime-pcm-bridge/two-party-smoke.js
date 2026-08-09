/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

const status = document.querySelector("#status");

setTimeout(async () => {
    try {
        const stream = await navigator.mediaDevices.getDisplayMedia({
            video: true,
            audio: {
                autoGainControl: false,
                noiseSuppression: false,
                voiceIsolation: false,
            },
        });
        status.textContent = `${stream.getVideoTracks().length}/${stream.getAudioTracks().length}`;
        if (stream.getVideoTracks().length !== 1 || stream.getAudioTracks().length !== 1)
            throw new Error("unexpected track count");
        await new Promise((resolve) => setTimeout(resolve, 500));
        for (const track of stream.getTracks()) track.stop();
        await new Promise((resolve) => setTimeout(resolve, 500));
        window.close();
    } catch (error) {
        status.textContent = String(error);
    }
}, 500);
