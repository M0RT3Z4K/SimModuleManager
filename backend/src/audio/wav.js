const fs = require('node:fs');

const HEADER_BYTES = 44;

function wavHeader(dataBytes, sampleRate, channels = 1, bits = 16) {
    const blockAlign = channels * bits / 8;
    const buffer = Buffer.alloc(HEADER_BYTES);
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + dataBytes, 4);
    buffer.write('WAVEfmt ', 8);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(channels, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * blockAlign, 28);
    buffer.writeUInt16LE(blockAlign, 32);
    buffer.writeUInt16LE(bits, 34);
    buffer.write('data', 36);
    buffer.writeUInt32LE(dataBytes, 40);
    return buffer;
}

function parseWav(buffer) {
    if (buffer.length < 12 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
        throw new Error('Invalid WAV file');
    }
    let offset = 12;
    let format = null;
    let dataOffset = null;
    let declaredDataBytes = null;
    while (offset + 8 <= buffer.length) {
        const id = buffer.toString('ascii', offset, offset + 4);
        const size = buffer.readUInt32LE(offset + 4);
        const payload = offset + 8;
        if (id === 'fmt ' && payload + Math.min(size, 16) <= buffer.length && size >= 16) {
            format = { codec: buffer.readUInt16LE(payload), channels: buffer.readUInt16LE(payload + 2), sampleRate: buffer.readUInt32LE(payload + 4), bits: buffer.readUInt16LE(payload + 14) };
        }
        if (id === 'data') { dataOffset = payload; declaredDataBytes = size; break; }
        offset = payload + size + (size % 2);
    }
    if (!format || dataOffset === null) throw new Error('WAV fmt/data chunks are missing');
    const dataBytes = Math.min(declaredDataBytes, Math.max(0, buffer.length - dataOffset)) & ~1;
    if (format.codec !== 1 || format.channels !== 1 || format.bits !== 16 || declaredDataBytes % 2) throw new Error('Expected mono signed 16-bit PCM');
    return { channels: format.channels, sampleRate: format.sampleRate, bits: format.bits, dataOffset, declaredDataBytes, dataBytes, samples: dataBytes / 2, durationMs: dataBytes / 2 / format.sampleRate * 1000 };
}

function audioStats(buffer) {
    const meta = parseWav(buffer);
    let sumSquares = 0;
    let peak = 0;
    let nonZero = 0;
    for (let offset = meta.dataOffset; offset < meta.dataOffset + meta.dataBytes; offset += 2) {
        const sample = buffer.readInt16LE(offset);
        if (sample !== 0) nonZero++;
        peak = Math.max(peak, Math.abs(sample));
        sumSquares += sample * sample;
    }
    const rms = meta.samples ? Math.sqrt(sumSquares / meta.samples) : 0;
    return { ...meta, rms: Math.round(rms), peak, allZero: nonZero === 0, nonZeroRatio: meta.samples ? nonZero / meta.samples : 0 };
}

function audioStatsFile(filePath) {
    const fd = fs.openSync(filePath, 'r');
    try {
        const probeSize = Math.min(fs.fstatSync(fd).size, 1024 * 1024);
        const probe = Buffer.alloc(probeSize);
        fs.readSync(fd, probe, 0, probeSize, 0);
        const declared = parseWav(probe);
        const actualDataBytes = Math.min(declared.declaredDataBytes, Math.max(0, fs.fstatSync(fd).size - declared.dataOffset)) & ~1;
        let sumSquares = 0, peak = 0, nonZero = 0, offset = 0;
        const chunk = Buffer.alloc(64 * 1024);
        while (offset < actualDataBytes) {
            const wanted = Math.min(chunk.length, actualDataBytes - offset) & ~1;
            const read = fs.readSync(fd, chunk, 0, wanted, declared.dataOffset + offset) & ~1;
            if (!read) break;
            for (let i = 0; i < read; i += 2) {
                const sample = chunk.readInt16LE(i);
                if (sample !== 0) nonZero++;
                peak = Math.max(peak, Math.abs(sample));
                sumSquares += sample * sample;
            }
            offset += read;
        }
        const samples = offset / 2;
        return { ...declared, dataBytes: offset, samples, durationMs: samples / declared.sampleRate * 1000, rms: samples ? Math.round(Math.sqrt(sumSquares / samples)) : 0, peak, allZero: nonZero === 0, nonZeroRatio: samples ? nonZero / samples : 0 };
    } finally { fs.closeSync(fd); }
}

class WavAppender {
    constructor(filePath, sampleRate, existing = false) {
        this.filePath = filePath;
        this.sampleRate = sampleRate;
        this.fd = fs.openSync(filePath, existing ? 'r+' : 'w+', 0o640);
        if (existing && fs.fstatSync(this.fd).size >= HEADER_BYTES) {
            this.dataBytes = fs.fstatSync(this.fd).size - HEADER_BYTES;
            fs.writeSync(this.fd, wavHeader(this.dataBytes, sampleRate), 0, HEADER_BYTES, 0);
        } else {
            this.dataBytes = 0;
            fs.writeSync(this.fd, wavHeader(0, sampleRate), 0, HEADER_BYTES, 0);
        }
    }

    append(buffer) {
        if (!buffer.length) return;
        if (buffer.length % 2) throw new Error('PCM append must end on a 16-bit sample boundary');
        fs.writeSync(this.fd, buffer, 0, buffer.length, HEADER_BYTES + this.dataBytes);
        this.dataBytes += buffer.length;
    }

    truncateData(dataBytes) {
        const aligned = Math.max(0, Math.min(this.dataBytes, dataBytes & ~1));
        fs.ftruncateSync(this.fd, HEADER_BYTES + aligned);
        this.dataBytes = aligned;
    }

    finalize() {
        fs.writeSync(this.fd, wavHeader(this.dataBytes, this.sampleRate), 0, HEADER_BYTES, 0);
        fs.fsyncSync(this.fd);
        fs.closeSync(this.fd);
        this.fd = null;
        return { dataBytes: this.dataBytes, sampleCount: this.dataBytes / 2 };
    }

    close() {
        if (this.fd !== null) fs.closeSync(this.fd);
        this.fd = null;
    }
}

function splitWav(buffer, maxBytes, overlapMs) {
    const meta = parseWav(buffer);
    if (buffer.length <= maxBytes) return [buffer];
    const maxData = Math.max(2, (maxBytes - HEADER_BYTES) & ~1);
    const overlapBytes = Math.min(maxData / 2, Math.floor(meta.sampleRate * overlapMs / 1000) * 2) & ~1;
    const chunks = [];
    let start = 0;
    while (start < meta.dataBytes) {
        const size = Math.min(maxData, meta.dataBytes - start) & ~1;
        const data = buffer.subarray(meta.dataOffset + start, meta.dataOffset + start + size);
        chunks.push(Buffer.concat([wavHeader(data.length, meta.sampleRate), data]));
        if (start + size >= meta.dataBytes) break;
        start += size - overlapBytes;
    }
    return chunks;
}

function* wavFileChunks(filePath, maxBytes, overlapMs) {
    const fd = fs.openSync(filePath, 'r');
    try {
        const probeSize = Math.min(fs.fstatSync(fd).size, 1024 * 1024);
        const probe = Buffer.alloc(probeSize);
        fs.readSync(fd, probe, 0, probeSize, 0);
        const validated = parseWav(probe);
        const sampleRate = validated.sampleRate;
        const dataBytes = Math.min(validated.declaredDataBytes, Math.max(0, fs.fstatSync(fd).size - validated.dataOffset)) & ~1;
        const maxData = Math.max(2, (maxBytes - HEADER_BYTES) & ~1);
        const overlapBytes = Math.min(maxData / 2, Math.floor(sampleRate * overlapMs / 1000) * 2) & ~1;
        let start = 0;
        while (start < dataBytes) {
            const size = Math.min(maxData, dataBytes - start) & ~1;
            const data = Buffer.alloc(size);
            fs.readSync(fd, data, 0, size, validated.dataOffset + start);
            yield Buffer.concat([wavHeader(size, sampleRate), data]);
            if (start + size >= dataBytes) break;
            start += size - overlapBytes;
        }
    } finally { fs.closeSync(fd); }
}

module.exports = { HEADER_BYTES, wavHeader, parseWav, audioStats, audioStatsFile, WavAppender, splitWav, wavFileChunks };
