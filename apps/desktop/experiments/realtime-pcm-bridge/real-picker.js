/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

window.realPickerHost.onOpen(({ requestId, sources }) => {
    const container = document.querySelector("#sources");
    for (const source of sources) {
        const button = document.createElement("button");
        button.className = "source";
        const image = document.createElement("img");
        image.src = source.thumbnail;
        image.alt = "";
        const label = document.createElement("span");
        label.textContent = source.name;
        button.append(image, label);
        button.addEventListener("click", () => window.realPickerHost.choose(requestId, source.id), { once: true });
        container.append(button);
    }
    document.querySelector("#cancel").addEventListener("click", () => window.realPickerHost.choose(requestId, null), {
        once: true,
    });
});
