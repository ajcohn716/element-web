/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import {
    PROCESS_LOOPBACK_HEADER_BYTES,
    PROCESS_LOOPBACK_MAGIC,
    PROCESS_LOOPBACK_VERSION,
} from "./process-loopback-protocol.mjs";

/* oxlint-disable unicorn/no-process-exit -- this deterministic fault child must model exact abnormal exits */

const scenario = process.argv[2];

function packet(type, payload = Buffer.alloc(0), sequence = 0, startFrame = 0, reason = 0) {
    const framed = Buffer.alloc(PROCESS_LOOPBACK_HEADER_BYTES + payload.length);
    framed.writeUInt32LE(PROCESS_LOOPBACK_MAGIC, 0);
    framed.writeUInt16LE(PROCESS_LOOPBACK_VERSION, 4);
    framed.writeUInt16LE(type, 6);
    framed.writeUInt32LE(PROCESS_LOOPBACK_HEADER_BYTES, 8);
    framed.writeUInt32LE(payload.length, 12);
    framed.writeBigUInt64LE(BigInt(sequence), 16);
    framed.writeBigUInt64LE(BigInt(startFrame), 24);
    framed.writeUInt32LE(reason, 36);
    payload.copy(framed, PROCESS_LOOPBACK_HEADER_BYTES);
    return framed;
}

function start() {
    const format = Buffer.alloc(16);
    format.writeUInt32LE(48_000, 0);
    format.writeUInt16LE(2, 4);
    format.writeUInt16LE(16, 6);
    format.writeUInt16LE(4, 8);
    format.writeUInt32LE(192_000, 12);
    return packet(1, format);
}

function waitForStop() {
    process.stdin.resume();
    process.stdin.once("data", () => process.exit(0));
    process.stdin.once("end", () => process.exit(0));
}

function streamSteady() {
    process.stdout.write(start());
    let sequence = 0;
    const payload = Buffer.alloc(1_920);
    let timer;
    let waitingForDrain = false;
    const pump = () => {
        if (stopped) return;
        const writable = process.stdout.write(packet(2, payload, sequence, sequence * 480));
        sequence += 1;
        if (writable) timer = setTimeout(pump, 10);
        else {
            waitingForDrain = true;
            process.stdout.once("drain", onDrain);
        }
    };
    const onDrain = () => {
        waitingForDrain = false;
        timer = setTimeout(pump, 10);
    };
    let stopped = false;
    const stop = () => {
        if (stopped) return;
        stopped = true;
        clearTimeout(timer);
        if (waitingForDrain) process.stdout.removeListener("drain", onDrain);
        process.stdout.end(packet(3, Buffer.alloc(0), sequence, sequence * 480));
    };
    process.stdin.resume();
    process.stdin.once("data", stop);
    process.stdin.once("end", stop);
    timer = setTimeout(pump, 10);
}

switch (scenario) {
    case "steady":
        streamSteady();
        break;
    case "exit-before-start":
        process.exit(21);
        break;
    case "delayed-start":
        waitForStop();
        break;
    case "init-reject":
        process.stderr.write("simulated capture initialization rejection\n");
        process.exit(22);
        break;
    case "unsupported-simulated":
        process.stderr.write("SIMULATED unsupported Windows process-loopback capability\n");
        process.exit(23);
        break;
    case "crash-active":
        process.stdout.write(start());
        process.stdout.write(packet(2, Buffer.alloc(1_920), 0, 0));
        setTimeout(() => process.exit(24), 250);
        break;
    case "stdout-close":
        process.stdout.write(start());
        waitForStop();
        break;
    case "truncated":
        process.stdout.write(start());
        setTimeout(
            () => process.stdout.write(packet(2, Buffer.alloc(16)).subarray(0, PROCESS_LOOPBACK_HEADER_BYTES + 3)),
            250,
        );
        waitForStop();
        break;
    case "malformed":
        process.stdout.write(start());
        setTimeout(() => process.stdout.write(Buffer.alloc(PROCESS_LOOPBACK_HEADER_BYTES, 0x7f)), 250);
        waitForStop();
        break;
    case "stall":
        process.stdout.write(start());
        waitForStop();
        break;
    case "burst": {
        process.stdout.write(start());
        const payload = Buffer.alloc(1_920);
        const packets = [];
        for (let sequence = 0; sequence < 200; sequence++) packets.push(packet(2, payload, sequence, sequence * 480));
        process.stdout.write(Buffer.concat(packets));
        waitForStop();
        break;
    }
    case "queue-overflow": {
        process.stdout.write(start());
        process.stdout.write(packet(2, Buffer.alloc(192_000), 0, 0));
        waitForStop();
        break;
    }
    case "target-exited":
        process.stdout.write(start());
        process.stdout.end(packet(3, Buffer.alloc(0), 0, 0, 2));
        waitForStop();
        break;
    default:
        process.stderr.write(`unknown R2 fault scenario: ${scenario}\n`);
        process.exit(64);
}
