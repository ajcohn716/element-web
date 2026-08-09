/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

export function validatePickerResult({ sender, expectedSender, result, requestId, sourceIds }) {
    if (sender !== expectedSender || !result || result.requestId !== requestId) return { accepted: false };
    if (result.sourceId === null) return { accepted: true, sourceId: null };
    if (typeof result.sourceId !== "string" || !sourceIds.has(result.sourceId)) return { accepted: false };
    return { accepted: true, sourceId: result.sourceId };
}

export async function prepareHostedPicker({ requestId, enumerateSources, openPicker, isCurrent, onFailure }) {
    try {
        const sources = await enumerateSources();
        if (!isCurrent(requestId)) return false;
        await openPicker(requestId, sources);
        return isCurrent(requestId);
    } catch {
        if (isCurrent(requestId)) onFailure(requestId, "source-selection-failed");
        return false;
    }
}

export function hostedTeardownOracle(snapshot) {
    const result = {
        state: snapshot.state,
        callbackCount: snapshot.callbackCount,
        producerProcesses: snapshot.producerProcesses,
        messagePorts: snapshot.messagePorts,
        bridgeWindows: snapshot.bridgeWindows,
        captureTimers: snapshot.captureTimers,
        adapterTimers: snapshot.adapterTimers,
        pickerWindows: snapshot.pickerWindows,
        ownedListeners: snapshot.ownedListeners,
        resources: snapshot.resources,
        teardownMilliseconds: snapshot.teardownMilliseconds,
    };
    result.passed =
        result.state === "Idle" &&
        result.callbackCount === 1 &&
        result.producerProcesses === 0 &&
        result.messagePorts === 0 &&
        result.bridgeWindows === 0 &&
        result.captureTimers === 0 &&
        result.adapterTimers === 0 &&
        result.pickerWindows === 0 &&
        result.ownedListeners === 0 &&
        result.resources === 0 &&
        Number.isFinite(result.teardownMilliseconds) &&
        result.teardownMilliseconds <= 1_000;
    return result;
}
