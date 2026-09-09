const path = require('node:path');

const rootDir = path.resolve(__dirname, '..');

function intEnv(name, fallback) {
    const value = Number.parseInt(process.env[name] || '', 10);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

module.exports = {
    rootDir,
    storageDir: path.resolve(process.env.CALL_STORAGE_DIR || path.join(rootDir, 'storage', 'calls')),
    databaseUrl: process.env.DATABASE_URL || 'file:./dev.db',
    adminApiToken: process.env.ADMIN_API_TOKEN || '',
    apiTokensJson: process.env.API_TOKENS_JSON || '',
    registrationToken: process.env.DEVICE_REGISTRATION_TOKEN || '',
    transcriptionApiKey: process.env.TRANSCRIPTION_API_KEY || '',
    ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
    receiverSyncMs: intEnv('RECEIVER_SYNC_MS', 2000),
    receiverLeaseMs: intEnv('RECEIVER_LEASE_MS', 15000),
    streamTimeoutMs: intEnv('DEVICE_STREAM_TIMEOUT_MS', 15000),
    healthTimeoutMs: intEnv('DEVICE_HEALTH_TIMEOUT_MS', 5000),
};
