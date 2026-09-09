class Pcm16Assembler {
    constructor() { this.pending = null; }

    push(chunk) {
        let buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (this.pending !== null) {
            buffer = Buffer.concat([Buffer.from([this.pending]), buffer]);
            this.pending = null;
        }
        if (buffer.length % 2) {
            this.pending = buffer[buffer.length - 1];
            buffer = buffer.subarray(0, buffer.length - 1);
        }
        return buffer;
    }

    reset() {
        const pending = this.pending;
        this.pending = null;
        return pending;
    }
}

class ByteRingBuffer {
    constructor(maxBytes) {
        this.maxBytes = Math.max(0, maxBytes & ~1);
        this.buffer = Buffer.alloc(0);
    }

    push(chunk) {
        if (!chunk.length || this.maxBytes === 0) return;
        this.buffer = Buffer.concat([this.buffer, chunk]);
        if (this.buffer.length > this.maxBytes) this.buffer = this.buffer.subarray(this.buffer.length - this.maxBytes);
    }

    snapshot() { return Buffer.from(this.buffer); }
}

module.exports = { Pcm16Assembler, ByteRingBuffer };
