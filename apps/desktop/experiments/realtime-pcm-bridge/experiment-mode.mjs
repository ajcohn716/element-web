/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

export function selectExperimentMode(arguments_) {
    const has = (flag) => arguments_.includes(flag);
    if (has("--real-two-party")) {
        if (!has("--real-producer")) throw new Error("--real-two-party requires --real-producer");
        return "real-two-party";
    }
    if (has("--r2-failures")) return "r2-failures";
    if (has("--real-producer")) return "real-producer";
    if (has("--two-party")) return "two-party";
    if (has("--lifecycle")) return "lifecycle";
    return "default";
}
