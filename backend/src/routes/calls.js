const express = require('express');
const fs = require('node:fs');
const { canAccessDevice } = require('../middleware/auth');
const { isManagedPath } = require('../services/storage');

const router = express.Router();

function parseJson(value, fallback) { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } }
function safeCall(call) {
    return {
        ...call,
        original_path: undefined,
        processed_path: undefined,
        original_available: Boolean(call.original_path && fs.existsSync(call.original_path)),
        processed_available: Boolean(call.processed_path && fs.existsSync(call.processed_path)),
        quality: parseJson(call.quality_json, null),
        missing_segments: parseJson(call.missing_segments_json, []),
    };
}

router.get('/', async (req, res) => {
    const where = {};
    if (req.auth.deviceIds) where.deviceId = { in: req.auth.deviceIds };
    if (req.query.device_id) {
        if (!canAccessDevice(req, req.query.device_id)) return res.status(403).json({ error: 'Device access denied' });
        where.deviceId = req.query.device_id;
    }
    if (req.query.iccid) where.sim_iccid_snapshot = req.query.iccid;
    if (req.query.number) where.caller_number = { contains: req.query.number };
    if (req.query.state) where.state = req.query.state;
    if (req.query.from || req.query.to) where.created_at = { ...(req.query.from ? { gte: new Date(req.query.from) } : {}), ...(req.query.to ? { lte: new Date(req.query.to) } : {}) };
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
    const [calls, total] = await Promise.all([
        req.prisma.call.findMany({ where, include: { device: { select: { id: true, label: true, receiver_status: true } } }, orderBy: { created_at: 'desc' }, skip: (page - 1) * limit, take: limit }),
        req.prisma.call.count({ where })
    ]);
    res.json({ data: calls.map(safeCall), pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
});

router.get('/:id', async (req, res) => {
    const call = await req.prisma.call.findUnique({ where: { id: req.params.id }, include: { device: { select: { id: true, label: true, receiver_status: true } }, events: { orderBy: { sequence: 'asc' } } } });
    if (!call || !canAccessDevice(req, call.deviceId)) return res.status(404).json({ error: 'Call not found' });
    res.json(safeCall(call));
});

router.get('/:id/audio/:variant', async (req, res) => {
    const call = await req.prisma.call.findUnique({ where: { id: req.params.id } });
    if (!call || !canAccessDevice(req, call.deviceId)) return res.status(404).json({ error: 'Call not found' });
    const filePath = req.params.variant === 'original' ? call.original_path : req.params.variant === 'processed' ? call.processed_path : null;
    if (!filePath || !isManagedPath(filePath) || !fs.existsSync(filePath)) return res.status(404).json({ error: 'Audio is not available' });
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Content-Disposition', `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="${call.id}-${req.params.variant}.wav"`);
    res.setHeader('Cache-Control', 'private, no-store');
    fs.createReadStream(filePath).pipe(res);
});

router.post('/:id/retry', async (req, res) => {
    const call = await req.prisma.call.findUnique({ where: { id: req.params.id } });
    if (!call || !canAccessDevice(req, call.deviceId)) return res.status(404).json({ error: 'Call not found' });
    const type = req.body.type;
    if (!['process', 'transcribe'].includes(type)) return res.status(400).json({ error: 'type must be process or transcribe' });
    if (type === 'process' && req.body.profile) {
        if (!['raw', 'mild', 'strong'].includes(req.body.profile)) return res.status(400).json({ error: 'Invalid audio profile' });
        await req.prisma.call.update({ where: { id: call.id }, data: { audio_profile: req.body.profile, processing_status: 'queued', transcription_status: 'waiting' } });
    } else await req.prisma.call.update({ where: { id: call.id }, data: type === 'process' ? { processing_status: 'queued' } : { transcription_status: 'queued' } });
    await req.prisma.processingJob.upsert({
        where: { callId_type_version: { callId: call.id, type, version: '1' } },
        update: { status: 'queued', attempts: 0, run_after: new Date(), locked_by: null, locked_at: null, last_error: null },
        create: { callId: call.id, type, version: '1' }
    });
    res.status(202).json({ queued: true });
});

router.delete('/:id', async (req, res) => {
    if (req.auth.role !== 'admin') return res.status(403).json({ error: 'Admin role required' });
    const call = await req.prisma.call.findUnique({ where: { id: req.params.id } });
    if (!call || !canAccessDevice(req, call.deviceId)) return res.status(404).json({ error: 'Call not found' });
    for (const filePath of [call.original_path, call.processed_path]) if (filePath && isManagedPath(filePath) && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    await req.prisma.call.delete({ where: { id: call.id } });
    res.status(204).end();
});

module.exports = router;
