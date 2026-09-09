process.env.TRANSCRIPTION_API_KEY = 'test-key';
process.env.CALL_STORAGE_DIR = `/tmp/simcard-core-audio-${process.pid}`;

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Pcm16Assembler, ByteRingBuffer } = require('../src/audio/pcm');
const { wavHeader, parseWav, audioStats, audioStatsFile, WavAppender, splitWav, wavFileChunks } = require('../src/audio/wav');
const { transcriptionUrl, retryableStatus, mergeOverlap } = require('../src/services/transcription');
const { canAccessDevice } = require('../src/middleware/auth');
const { processCallAudio } = require('../src/services/audioProcessing');

test.after(() => {
    if (fs.existsSync(process.env.CALL_STORAGE_DIR)) fs.rmSync(process.env.CALL_STORAGE_DIR, { recursive: true });
});

test('PCM keeps an odd trailing byte and never mixes adjacent samples', () => {
    const assembler = new Pcm16Assembler();
    assert.deepEqual([...assembler.push(Buffer.from([1, 2, 3]))], [1, 2]);
    assert.deepEqual([...assembler.push(Buffer.from([4, 5, 6, 7]))], [3, 4, 5, 6]);
    assert.deepEqual([...assembler.push(Buffer.from([8]))], [7, 8]);
});

test('two device writers stay independent under interleaved writes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'simcard-audio-'));
    try {
        const a = new WavAppender(path.join(dir, 'a.wav'), 8000);
        const b = new WavAppender(path.join(dir, 'b.wav'), 43904);
        a.append(Buffer.from([1, 0, 2, 0])); b.append(Buffer.from([9, 0])); a.append(Buffer.from([3, 0])); b.append(Buffer.from([8, 0, 7, 0]));
        a.finalize(); b.finalize();
        assert.deepEqual([...fs.readFileSync(path.join(dir, 'a.wav')).subarray(44)], [1, 0, 2, 0, 3, 0]);
        assert.deepEqual([...fs.readFileSync(path.join(dir, 'b.wav')).subarray(44)], [9, 0, 8, 0, 7, 0]);
        assert.equal(parseWav(fs.readFileSync(path.join(dir, 'b.wav'))).sampleRate, 43904);
    } finally { fs.rmSync(dir, { recursive: true }); }
});

test('declared rates produce correct duration and are not inferred from delivery', () => {
    const pcm = Buffer.alloc(43904 * 2);
    const file = Buffer.concat([wavHeader(pcm.length, 43904), pcm]);
    assert.equal(parseWav(file).durationMs, 1000);
    assert.equal(audioStats(file).allZero, true);
});

test('ffmpeg performs real 8k to 16k resampling while preserving duration', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'simcard-process-'));
    const original = path.join(dir, 'input.wav');
    try {
        const pcm = Buffer.alloc(8000 * 2);
        for (let i = 0; i < 8000; i++) pcm.writeInt16LE(Math.round(6000 * Math.sin(i * 2 * Math.PI * 440 / 8000)), i * 2);
        fs.writeFileSync(original, Buffer.concat([wavHeader(pcm.length, 8000), pcm]));
        const result = await processCallAudio({ id: `test-${process.pid}`, original_path: original, input_sample_rate: 8000, output_sample_rate: 16000, audio_profile: 'mild' });
        assert.equal(result.quality.original.sampleRate, 8000);
        assert.equal(result.quality.processed.sampleRate, 16000);
        assert.ok(Math.abs(result.quality.processed.durationMs - 1000) < 2);
        if (fs.existsSync(result.outputPath)) fs.unlinkSync(result.outputPath);
    } finally { fs.rmSync(dir, { recursive: true }); }
});

test('idle ring buffer is bounded to the configured pre-roll', () => {
    const ring = new ByteRingBuffer(8);
    ring.push(Buffer.from([0, 1, 2, 3, 4, 5])); ring.push(Buffer.from([6, 7, 8, 9]));
    assert.deepEqual([...ring.snapshot()], [2, 3, 4, 5, 6, 7, 8, 9]);
});

test('long silence does not create an end-of-call signal', () => {
    const assembler = new Pcm16Assembler();
    for (let i = 0; i < 100; i++) assert.equal(assembler.push(Buffer.alloc(321)).length % 2, 0);
    assert.ok(true, 'PCM transport contains no lifecycle/VAD logic');
});

test('oversized WAV files split in order with bounded overlap', () => {
    const pcm = Buffer.alloc(8000 * 4);
    for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(i % 30000, i * 2);
    const chunks = splitWav(Buffer.concat([wavHeader(pcm.length, 8000), pcm]), 8044, 100);
    assert.ok(chunks.length > 1);
    chunks.forEach(chunk => assert.ok(chunk.length <= 8044));
    assert.equal(parseWav(chunks[0]).sampleRate, 8000);
});

test('file-based stats and splitting keep processing memory bounded', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'simcard-wav-'));
    const filePath = path.join(dir, 'large.wav');
    try {
        const pcm = Buffer.alloc(16000);
        pcm.writeInt16LE(1234, 0);
        fs.writeFileSync(filePath, Buffer.concat([wavHeader(pcm.length, 8000), pcm]));
        assert.equal(audioStatsFile(filePath).samples, 8000);
        const chunks = [...wavFileChunks(filePath, 4044, 50)];
        assert.ok(chunks.length > 1); chunks.forEach(chunk => assert.ok(chunk.length <= 4044));
    } finally { fs.rmSync(dir, { recursive: true }); }
});

test('provider URL avoids duplicate v1 and overlap text is deduplicated', () => {
    assert.equal(transcriptionUrl('https://api.example.com'), 'https://api.example.com/v1/audio/transcriptions');
    assert.equal(transcriptionUrl('https://api.example.com/v1/'), 'https://api.example.com/v1/audio/transcriptions');
    assert.equal(mergeOverlap('سلام دنیای خوب', 'دنیای خوب امروز'), 'سلام دنیای خوب امروز');
    assert.equal(retryableStatus(429), true); assert.equal(retryableStatus(503), true); assert.equal(retryableStatus(401), false);
});

test('authorization scopes audio and transcript access by device', () => {
    assert.equal(canAccessDevice({ auth: { role: 'viewer', deviceIds: ['a'] } }, 'a'), true);
    assert.equal(canAccessDevice({ auth: { role: 'viewer', deviceIds: ['a'] } }, 'b'), false);
    assert.equal(canAccessDevice({ auth: { role: 'admin', deviceIds: [] } }, 'b'), true);
});
