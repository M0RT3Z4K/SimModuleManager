const express = require('express');
const config = require('../config');
const router = express.Router();

router.get('/', async (req, res) => {
    const [provider, policy] = await Promise.all([
        req.prisma.providerConfig.upsert({ where: { id: 'default' }, update: {}, create: { id: 'default' } }),
        req.prisma.recordingPolicy.upsert({ where: { id: 'default' }, update: {}, create: { id: 'default' } }),
    ]);
    res.json({ provider: { ...provider, api_key_configured: Boolean(config.transcriptionApiKey) }, policy });
});

router.patch('/provider', async (req, res) => {
    if (req.auth.role !== 'admin') return res.status(403).json({ error: 'Admin role required' });
    const fields = ['base_url', 'model', 'language', 'response_format', 'supports_language', 'supports_response_format', 'timeout_ms', 'concurrency', 'max_file_bytes', 'chunk_overlap_ms', 'max_attempts'];
    const data = {};
    for (const key of fields) if (req.body[key] !== undefined) data[key] = req.body[key];
    try { new URL(data.base_url || 'https://example.com/v1'); } catch { return res.status(400).json({ error: 'base_url must be an absolute URL' }); }
    if (data.model !== undefined && !String(data.model).trim()) return res.status(400).json({ error: 'model is required' });
    const numericRanges = { timeout_ms: [1000, 600000], concurrency: [1, 20], max_file_bytes: [1024, 2000000000], chunk_overlap_ms: [0, 10000], max_attempts: [1, 10] };
    for (const [key, [min, max]] of Object.entries(numericRanges)) {
        if (data[key] !== undefined && (!Number.isSafeInteger(data[key]) || data[key] < min || data[key] > max)) return res.status(400).json({ error: `${key} must be an integer from ${min} to ${max}` });
    }
    const provider = await req.prisma.providerConfig.upsert({ where: { id: 'default' }, update: data, create: { id: 'default', ...data } });
    res.json({ ...provider, api_key_configured: Boolean(config.transcriptionApiKey) });
});

router.patch('/policy', async (req, res) => {
    if (req.auth.role !== 'admin') return res.status(403).json({ error: 'Admin role required' });
    const fields = ['pre_roll_ms', 'max_call_bytes', 'retention_days', 'max_storage_bytes', 'delete_transcript'];
    const data = {};
    for (const key of fields) if (req.body[key] !== undefined) data[key] = req.body[key];
    for (const key of ['pre_roll_ms', 'max_call_bytes', 'retention_days', 'max_storage_bytes']) {
        if (data[key] !== undefined && (!Number.isSafeInteger(data[key]) || data[key] < 0 || data[key] > 2000000000)) return res.status(400).json({ error: `${key} is outside the SQLite-safe range` });
    }
    const policy = await req.prisma.recordingPolicy.upsert({ where: { id: 'default' }, update: data, create: { id: 'default', ...data } });
    res.json(policy);
});

module.exports = router;
