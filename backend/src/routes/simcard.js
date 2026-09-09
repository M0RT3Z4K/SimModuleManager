const express = require('express');
const axios = require('axios');
const { fetchDeviceContacts } = require('../services/deviceContacts');
const router = express.Router();

router.get('/', async (req, res) => {
    const deviceFilter = req.auth.deviceIds ? { deviceId: { in: req.auth.deviceIds } } : {};
    const simcards = await req.prisma.simcard.findMany({ where: deviceFilter, include: { device: true }, orderBy: { last_seen: 'desc' } });
    res.json(simcards.map(sim => ({ ...sim, device: sim.device ? { ...sim.device, device_key_hash: undefined } : null })));
});

router.get('/:iccid/sms', async (req, res) => {
    const sim = await req.prisma.simcard.findUnique({ where: { iccid: req.params.iccid } });
    if (!sim || (req.auth.deviceIds && (!sim.deviceId || !req.auth.deviceIds.includes(sim.deviceId)))) return res.status(404).json({ error: 'Simcard not found' });
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const [data, total] = await Promise.all([
        req.prisma.sms.findMany({ where: { simcardId: sim.iccid }, orderBy: { timestamp: 'desc' }, skip: (page - 1) * limit, take: limit }),
        req.prisma.sms.count({ where: { simcardId: sim.iccid } })
    ]);
    res.json({ data, pagination: { total, page, limit, totalPages: Math.ceil(total / limit) } });
});

router.post('/:iccid/send', async (req, res) => {
    const { phone, message } = req.body;
    if (!phone || !message) return res.status(400).json({ error: 'phone and message are required' });
    const sim = await req.prisma.simcard.findUnique({ where: { iccid: req.params.iccid } });
    if (!sim || (req.auth.deviceIds && (!sim.deviceId || !req.auth.deviceIds.includes(sim.deviceId)))) return res.status(404).json({ error: 'Simcard not found' });
    if (!sim.ip_address) return res.status(409).json({ error: 'No device IP is known' });
    try {
        await axios.post(`http://${sim.ip_address}/send-sms`, { phone, message }, { timeout: 10000 });
        const sms = await req.prisma.sms.create({ data: { simcardId: sim.iccid, sender_number: phone, message_text: message, timestamp: new Date(), direction: 'outgoing' } });
        res.json({ success: true, sms });
    } catch (error) { res.status(502).json({ error: `Failed to communicate with device: ${error.message}` }); }
});

router.get('/:iccid/contacts', async (req, res) => {
    const sim = await req.prisma.simcard.findUnique({ where: { iccid: req.params.iccid }, include: { device: true } });
    if (!sim || (req.auth.deviceIds && (!sim.deviceId || !req.auth.deviceIds.includes(sim.deviceId)))) return res.status(404).json({ error: 'Simcard not found' });
    if (!sim.device || !sim.device.ip_address || !sim.device.active || sim.device.deleted_at) return res.status(409).json({ error: 'The current SIM has no active registered device IP' });
    try {
        const contacts = await fetchDeviceContacts(sim.device.ip_address);
        const fetchedAt = new Date();
        await req.prisma.$transaction(async tx => {
            await tx.contact.deleteMany({ where: { simcardId: sim.iccid } });
            if (contacts.length) await tx.contact.createMany({ data: contacts.map(contact => ({ ...contact, simcardId: sim.iccid, fetched_at: fetchedAt })) });
        });
        res.json({ contacts, iccid: sim.iccid, device_id: sim.device.id, fetched_at: fetchedAt, stale: false });
    } catch (error) {
        console.error(`Contacts fetch failed for device ${sim.device.id}:`, error.message);
        const cached = await req.prisma.contact.findMany({ where: { simcardId: sim.iccid }, orderBy: [{ name: 'asc' }, { id: 'asc' }] });
        const status = error.code === 'CONTACTS_TIMEOUT' ? 504 : 502;
        res.status(status).json({ error: error.message, code: error.code, iccid: sim.iccid, cached_contacts: cached.map(({ id, simcardId, ...contact }) => contact), stale: true });
    }
});

module.exports = router;
