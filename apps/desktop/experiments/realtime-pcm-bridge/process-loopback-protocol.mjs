/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

export const PROCESS_LOOPBACK_MAGIC = 0x414d4350;
export const PROCESS_LOOPBACK_VERSION = 1;
export const PROCESS_LOOPBACK_HEADER_BYTES = 48;
export const MAX_PCM_PAYLOAD_BYTES = 192_000;
export const MAX_PROTOCOL_BUFFER_BYTES = (PROCESS_LOOPBACK_HEADER_BYTES + MAX_PCM_PAYLOAD_BYTES) * 2;

export class ProcessLoopbackProtocolParser {
    constructor({ onPacket, onError, maxBufferedBytes = MAX_PROTOCOL_BUFFER_BYTES } = {}) {
        this.onPacket = onPacket ?? (() => {});
        this.onError = onError ?? (() => {});
        this.maxBufferedBytes = maxBufferedBytes;
        this.buffer = Buffer.alloc(0);
        this.started = false;
        this.ended = false;
        this.failed = false;
        this.expectedSequence = 0;
        this.expectedStartFrame = 0;
        this.bufferHighWaterBytes = 0;
        this.rejectedBufferedBytes = 0;
    }

    push(chunk) {
        if (this.failed || !chunk?.length) return;
        if (this.ended) return this.#fail("trailing data after END");
        if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
        const attemptedBufferedBytes = this.buffer.length + chunk.length;
        if (attemptedBufferedBytes > this.maxBufferedBytes) {
            this.rejectedBufferedBytes = Math.max(this.rejectedBufferedBytes, attemptedBufferedBytes);
            return this.#fail("parser buffer cap exceeded");
        }
        this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
        this.bufferHighWaterBytes = Math.max(this.bufferHighWaterBytes, this.buffer.length);
        while (this.buffer.length >= PROCESS_LOOPBACK_HEADER_BYTES && !this.failed) {
            const payloadBytes = this.buffer.readUInt32LE(12);
            if (payloadBytes > MAX_PCM_PAYLOAD_BYTES) return this.#fail("payload cap exceeded");
            const packetBytes = PROCESS_LOOPBACK_HEADER_BYTES + payloadBytes;
            if (this.buffer.length < packetBytes) return;
            const packetBuffer = this.buffer.subarray(0, packetBytes);
            this.buffer = this.buffer.subarray(packetBytes);
            if (packetBuffer.readUInt16LE(6) === 3 && this.buffer.length !== 0)
                return this.#fail("trailing data after END");
            this.#parse(packetBuffer, payloadBytes);
        }
    }

    finish() {
        if (this.failed) return;
        if (this.buffer.length !== 0) return this.#fail("truncated protocol packet");
        if (!this.ended) this.#fail("producer EOF before END");
    }

    #parse(packet, payloadBytes) {
        const magic = packet.readUInt32LE(0);
        const version = packet.readUInt16LE(4);
        const type = packet.readUInt16LE(6);
        const headerBytes = packet.readUInt32LE(8);
        if (
            magic !== PROCESS_LOOPBACK_MAGIC ||
            version !== PROCESS_LOOPBACK_VERSION ||
            headerBytes !== PROCESS_LOOPBACK_HEADER_BYTES
        )
            return this.#fail("unsupported protocol header");
        const parsed = {
            type,
            sequence: Number(packet.readBigUInt64LE(16)),
            startFrame: Number(packet.readBigUInt64LE(24)),
            flags: packet.readUInt32LE(32),
            reason: packet.readUInt32LE(36),
            counter: Number(packet.readBigUInt64LE(40)),
            payload: packet.subarray(PROCESS_LOOPBACK_HEADER_BYTES),
        };
        if (
            !Number.isSafeInteger(parsed.sequence) ||
            !Number.isSafeInteger(parsed.startFrame) ||
            !Number.isSafeInteger(parsed.counter)
        )
            return this.#fail("protocol counter exceeds JavaScript safe integer range");
        if (type === 1) {
            if (this.started || payloadBytes !== 16 || parsed.sequence !== 0 || parsed.startFrame !== 0)
                return this.#fail("invalid START packet");
            parsed.format = {
                sampleRate: parsed.payload.readUInt32LE(0),
                channels: parsed.payload.readUInt16LE(4),
                bitsPerSample: parsed.payload.readUInt16LE(6),
                blockAlign: parsed.payload.readUInt16LE(8),
                bytesPerSecond: parsed.payload.readUInt32LE(12),
            };
            if (
                parsed.format.sampleRate !== 48_000 ||
                parsed.format.channels !== 2 ||
                parsed.format.bitsPerSample !== 16 ||
                parsed.format.blockAlign !== 4 ||
                parsed.format.bytesPerSecond !== 192_000
            )
                return this.#fail("unsupported PCM format");
            this.started = true;
        } else if (type === 2) {
            if (!this.started || this.ended || payloadBytes === 0 || payloadBytes % 4 !== 0)
                return this.#fail("invalid PCM packet");
            if (parsed.sequence !== this.expectedSequence || parsed.startFrame !== this.expectedStartFrame)
                return this.#fail("non-contiguous PCM packet");
            this.expectedSequence += 1;
            this.expectedStartFrame += payloadBytes / 4;
        } else if (type === 3) {
            if (
                !this.started ||
                this.ended ||
                payloadBytes !== 0 ||
                parsed.sequence !== this.expectedSequence ||
                parsed.startFrame !== this.expectedStartFrame
            )
                return this.#fail("invalid END packet");
            this.ended = true;
        } else {
            return this.#fail("unknown packet type");
        }
        this.onPacket(parsed);
    }

    #fail(message) {
        if (this.failed) return;
        this.failed = true;
        this.buffer = Buffer.alloc(0);
        this.onError(new Error(message));
    }
}
