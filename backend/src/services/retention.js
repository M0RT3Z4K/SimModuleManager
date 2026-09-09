const fs = require('node:fs');
const { isManagedPath } = require('./storage');

function remove(filePath) {
    if (filePath && isManagedPath(filePath) && fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

async function enforceRetention(prisma) {
    const policy = await prisma.recordingPolicy.upsert({ where: { id: 'default' }, update: {}, create: { id: 'default' } });
    const expired = await prisma.call.findMany({
        where: { ended_at: { lt: new Date(Date.now() - policy.retention_days * 86400000) }, state: { in: ['ended', 'missed', 'interrupted'] } },
        orderBy: { ended_at: 'asc' }
    });
    for (const call of expired) {
        remove(call.original_path);
        remove(call.processed_path);
        await prisma.call.update({
            where: { id: call.id },
            data: { original_path: null, processed_path: null, recording_status: 'expired', processing_status: 'expired', ...(policy.delete_transcript ? { transcript: null, transcription_status: 'expired' } : {}) }
        });
    }

    const calls = await prisma.call.findMany({ where: { OR: [{ original_path: { not: null } }, { processed_path: { not: null } }] }, orderBy: { ended_at: 'asc' } });
    let total = 0;
    const sized = calls.map(call => {
        let bytes = 0;
        for (const filePath of [call.original_path, call.processed_path]) if (filePath && isManagedPath(filePath) && fs.existsSync(filePath)) bytes += fs.statSync(filePath).size;
        total += bytes;
        return { call, bytes };
    });
    for (const { call, bytes } of sized) {
        if (total <= policy.max_storage_bytes) break;
        if (call.state === 'active') continue;
        remove(call.original_path);
        remove(call.processed_path);
        total -= bytes;
        await prisma.call.update({ where: { id: call.id }, data: { original_path: null, processed_path: null, recording_status: 'quota_deleted', processing_status: 'quota_deleted' } });
    }
}

function startRetentionDaemon(prisma) {
    enforceRetention(prisma).catch(error => console.error('Retention check failed:', error));
    const timer = setInterval(() => enforceRetention(prisma).catch(error => console.error('Retention check failed:', error)), 60 * 60 * 1000);
    return () => clearInterval(timer);
}

module.exports = { enforceRetention, startRetentionDaemon };
