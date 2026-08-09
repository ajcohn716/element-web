/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { execFile } from "node:child_process";

export function parseWindowSourceId(sourceId) {
    const match = /^window:([1-9]\d*):0$/.exec(sourceId);
    if (!match) throw new Error("selected source is not a supported window source");
    const hwnd = Number(match[1]);
    if (!Number.isSafeInteger(hwnd)) throw new Error("window handle exceeds JavaScript safe integer range");
    return hwnd;
}

export function resolveWindowSource(executable, sourceId, run = execFile) {
    parseWindowSourceId(sourceId);
    return new Promise((resolve, reject) => {
        run(
            executable,
            ["source", sourceId],
            { windowsHide: true, encoding: "utf8", timeout: 3_000 },
            (error, stdout) => {
                if (error) return reject(new Error("window source is stale or unavailable"));
                const pidMatch = /^pid=(\d+)$/m.exec(stdout);
                if (!pidMatch) return reject(new Error("window source resolver returned no PID"));
                const pid = Number(pidMatch[1]);
                if (!Number.isInteger(pid) || pid <= 0)
                    return reject(new Error("window source resolver returned an invalid PID"));
                resolve({ sourceId, hwnd: parseWindowSourceId(sourceId), pid });
            },
        );
    });
}
