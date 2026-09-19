const fs = require('node:fs');
const { spawn } = require('node:child_process');
const config = require('../config');
const { audioStatsFile } = require('../audio/wav');
const { safeCallPath } = require('./storage');

const PROCESSING_VERSION = '4';

const OUTPUT_SAMPLE_RATES = new Set([8000, 16000, 24000, 32000, 48000]);

function checkedOutputRate(outputRate) {
    const rate = Number(outputRate);
    if (!Number.isInteger(rate) || !OUTPUT_SAMPLE_RATES.has(rate)) {
        throw new Error('Unsupported output sample rate');
    }
    return rate;
}

function filterFor(profile, outputRate, inputStats = null) {
    const resample = `aresample=${checkedOutputRate(outputRate)}`;
    if (profile === 'raw') return resample;
    // Use one internal rate so the adaptive filters behave consistently for
    // every supported device rate. It also avoids an FFmpeg anlmdn/adeclick
    // crash observed when the filters receive 48 kHz float/Opus-decoded audio.
    const analysisRate = 'aresample=16000';
    if (profile === 'strong') {
        // A hot capture already has enough speech energy. Heavy NLM filtering
        // on it creates metallic/musical artifacts and can erase consonants.
        if (inputStats && (inputStats.rms >= 1800 || inputStats.peak >= 32760)) {
            return `${analysisRate},adeclick=w=55:o=75:a=2:t=2:b=2:m=a,highpass=f=100:p=2,lowpass=f=3800:p=2,afftdn=nr=10:nf=-55:tn=1:tr=1:gs=5,equalizer=f=1800:t=q:w=1:g=2,speechnorm=e=5:c=2.5:t=0.008:r=0.0005:f=0.0005,loudnorm=I=-18:LRA=8:TP=-2,${resample}`;
        }
        // The analog modem path contains short full-band spikes as well as
        // stationary ADC/GSM noise. Repair spikes before learning the noise
        // floor, then add a restrained presence lift for telephone consonants.
        return `${analysisRate},adeclick=w=55:o=75:a=2:t=2:b=2:m=a,highpass=f=150:p=2,lowpass=f=3400:p=2,afftdn=nr=22:nf=-52:tn=1:tr=1:gs=12,anlmdn=s=0.004:p=0.002:r=0.008:m=15,equalizer=f=1800:t=q:w=1:g=3,equalizer=f=2800:t=q:w=1.2:g=2,speechnorm=e=10:c=4:t=0.005:r=0.0005:f=0.0005,loudnorm=I=-18:LRA=6:TP=-2,${resample}`;
    }
    // Keep consonants while suppressing stationary GSM/ADC noise, then raise
    // quiet telephone speech before a true-peak limited loudness pass.
    return `${analysisRate},highpass=f=120:p=2,lowpass=f=3600:p=2,afftdn=nr=15:nf=-55:tn=1:tr=1:gs=8,anlmdn=s=0.002:p=0.002:r=0.006:m=11,equalizer=f=2000:t=q:w=1.1:g=1.5,speechnorm=e=8:c=3:t=0.004:r=0.0005:f=0.0005,loudnorm=I=-18:LRA=7:TP=-2,${resample}`;
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
    const processingMode = profile === 'strong' && (before.rms >= 1800 || before.peak >= 32760)
        ? 'strong-high-signal' : profile;
    const outputPath = safeCallPath(call.id, 'processed');
    const tempPath = `${outputPath}.${process.pid}.tmp.wav`;
    try {
        await runFfmpeg([
            '-hide_banner', '-loglevel', 'error', '-y', '-i', call.original_path,
            '-af', filterFor(profile, call.output_sample_rate || 16000, before),
            '-ac', '1', '-c:a', 'pcm_s16le', tempPath,
        ]);
        const after = audioStatsFile(tempPath);
        fs.renameSync(tempPath, outputPath);
        return { outputPath, quality: { original: before, processed: after, profile, processingMode }, profile };
    } finally {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    }
}

module.exports = { PROCESSING_VERSION, filterFor, processCallAudio };
