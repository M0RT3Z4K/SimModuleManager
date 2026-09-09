const express = require('express');
const router = express.Router();
const { parseSmsTimestamp } = require('../services/smsTimestamp');

router.post('/sms', async (req, res) => {
    const { iccid, sender, message, timestamp } = req.body;
    
    if (!iccid || !sender || !message) {
        return res.status(400).json({ error: 'iccid, sender, and message are required' });
    }

    let smsTimestamp;
    try {
        smsTimestamp = parseSmsTimestamp(timestamp);
    } catch {
        return res.status(400).json({ error: 'Invalid timestamp: expected SIM800 or ISO 8601 with timezone' });
    }

    try {
        // Ensure simcard exists in DB, even if just receiving an SMS
        // ESP32 usually registers first, but just in case
        let simcard = await req.prisma.simcard.findUnique({ where: { iccid } });
        if (!simcard) {
            simcard = await req.prisma.simcard.create({
                data: {
                    iccid,
                    status: 'online',
                    last_seen: new Date()
                }
            });
        }

        const smsRecord = await req.prisma.sms.create({
            data: {
                simcardId: iccid,
                sender_number: sender,
                message_text: message,
                timestamp: smsTimestamp,
                direction: 'incoming'
            }
        });

        res.json({ success: true, sms: smsRecord });
    } catch (error) {
        console.error('Error in webhook /sms:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
