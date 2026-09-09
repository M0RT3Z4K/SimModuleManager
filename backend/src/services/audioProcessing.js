const fs = require('node:fs');
const { spawn } = require('node:child_process');
const config = require('../config');
const { audioStatsFile } = require('../audio/wav');
const { safeCallPath } = require('./storage');

const PROCESSING_VERSION = '1';

function filterFor(profile, outputRate) {
    const resample = `aresample=${outputRate}`;
    if (profile === 'raw') return resample;
    if (profile === 'strong') return `highpass=f=120:p=2,lowpass=f=3600:p=2,afftdn=nf=-26:tn=1:gs=8,dynaudnorm=f=250:g=8:p=0.9:m=6,${resample}`;
    return `highpass=f=100:p=2,lowpass=f=3800:p=2,afftdn=nf=-32:tn=1:gs=12,dynaudnorm=f=400:g=5:p=0.95:m=4,${resample}`;
}

function runFfmpeg(args) {
    return new Promise((resolve, reject) => {
        const child = spawn(config.ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-8000); });
        child.on('error', error => reject(new Error(`ffmpeg is unavailable: ${error.message}`)));
        child.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg failed (${code}): ${stderr.slice(-1200)}`)));
    });
}

async function processCallAudio(call) {
    if (!call.original_path || !fs.existsSync(call.original_path)) throw new Error('Original recording is missing');
    const before = audioStatsFile(call.original_path);
    if (before.sampleRate !== call.input_sample_rate) throw new Error('WAV rate does not match the declared device input rate');
    if (before.allZero || before.rms < 2) {
        const error = new Error('Recording is all-zero or has no probable signal; transcription was skipped');
        error.noSignal = true;
        error.quality = before;
        throw error;
    }
    const profile = ['raw', 'mild', 'strong'].includes(call.audio_profile) ? call.audio_profile : 'mild';
    const outputPath = safeCallPath(call.id, 'processed');
    const tempPath = `${outputPath}.${process.pid}.tmp.wav`;
    try {
        await runFfmpeg([
            '-hide_banner', '-loglevel', 'error', '-y', '-i', call.original_path,
            '-af', filterFor(profile, call.output_sample_rate || 16000),
            '-ac', '1', '-c:a', 'pcm_s16le', tempPath,
        ]);
        const after = audioStatsFile(tempPath);
        fs.renameSync(tempPath, outputPath);
        return { outputPath, quality: { original: before, processed: after, profile }, profile };
    } finally {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    }
}

module.exports = { PROCESSING_VERSION, filterFor, processCallAudio };
