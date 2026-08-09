/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

const start = document.querySelector("#start");
const stop = document.querySelector("#stop");
const picker = document.querySelector("#picker");
const sources = document.querySelector("#sources");
const video = document.querySelector("#video");
const status = document.querySelector("#status");
let stream;
let pickerRequest;

window.realProducerHost.onPicker((request) => {
    pickerRequest = request.requestId;
    sources.replaceChildren();
    for (const source of request.sources) {
        const button = document.createElement("button");
        button.className = "source";
        const image = document.createElement("img");
        image.src = source.thumbnail;
        image.alt = "";
        const label = document.createElement("div");
        label.textContent = source.name;
        button.append(image, label);
        button.addEventListener("click", () => {
            window.realProducerHost.choose(request.requestId, source.id);
            picker.hidden = true;
        });
        sources.append(button);
    }
    picker.hidden = false;
});

document.querySelector("#cancel").addEventListener("click", () => {
    window.realProducerHost.choose(pickerRequest, null);
    picker.hidden = true;
});

start.addEventListener("click", async () => {
    try {
        stream = await navigator.mediaDevices.getDisplayMedia({
            video: true,
            audio: {
                autoGainControl: false,
                noiseSuppression: false,
                voiceIsolation: false,
                echoCancellation: false,
                channelCount: { ideal: 2 },
            },
        });
        video.srcObject = stream;
        start.disabled = true;
        stop.disabled = false;
        status.textContent = JSON.stringify(
            { tracks: stream.getTracks().map((track) => ({ kind: track.kind, settings: track.getSettings() })) },
            null,
            2,
        );
    } catch (error) {
        status.textContent = `${error.name}: ${error.message}`;
    }
});

stop.addEventListener("click", () => {
    stream?.getTracks().forEach((track) => track.stop());
    video.srcObject = null;
    stream = undefined;
    start.disabled = false;
    stop.disabled = true;
});
