const express = require('express');
const { deviceAuth } = require('../middleware/auth');
const { applyCallEvent } = require('../services/callEvents');

const router = express.Router();

router.post('/:deviceId/events', deviceAuth, async (req, res) => {
    try {
        const result = await applyCallEvent(req.prisma, req.device, req.body);
        res.status(result.duplicate ? 200 : 202).json({ accepted: true, duplicate: result.duplicate, call_id: result.call?.id });
    } catch (error) {
        console.error('Call event rejected:', error.message);
        res.status(error.status || 500).json({ error: error.status ? error.message : 'Failed to store call event' });
    }
});

module.exports = router;
