const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');

function ensureStorage() {
    fs.mkdirSync(config.storageDir, { recursive: true, mode: 0o750 });
}

function safeCallPath(callId, variant) {
    if (!/^[a-zA-Z0-9_-]+$/.test(callId)) throw new Error('Invalid call id');
    if (!['original', 'processed'].includes(variant)) throw new Error('Invalid audio variant');
    ensureStorage();
    return path.join(config.storageDir, `${callId}-${variant}.wav`);
}

function isManagedPath(filePath) {
    const resolved = path.resolve(filePath || '');
    return resolved.startsWith(`${config.storageDir}${path.sep}`);
}

module.exports = { ensureStorage, safeCallPath, isManagedPath };
