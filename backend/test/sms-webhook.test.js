const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { parseSmsTimestamp } = require('../src/services/smsTimestamp');
const webhook = require('../src/routes/webhook');

test('SIM800 timestamp applies quarter-hour timezone without host timezone dependence', () => {
    assert.equal(parseSmsTimestamp('26/09/09,16:02:37+14').toISOString(), '2026-09-09T12:32:37.000Z');
    assert.equal(parseSmsTimestamp('26/01/01,01:00:00+14').toISOString(), '2025-12-31T21:30:00.000Z');
    assert.equal(parseSmsTimestamp('26/09/09,16:02:37-14').toISOString(), '2026-09-09T19:32:37.000Z');
    assert.equal(parseSmsTimestamp('24/02/29,00:00:00+00').toISOString(), '2024-02-29T00:00:00.000Z');
});

test('missing timestamps use receipt time; ISO retains its timezone', () => {
    const now = new Date('2026-09-09T00:00:00Z');
    for (const value of [undefined, null, '']) assert.equal(parseSmsTimestamp(value, now), now);
    assert.equal(parseSmsTimestamp('2026-09-09T16:02:37+03:30').toISOString(), '2026-09-09T12:32:37.000Z');
});

test('invalid modem dates and offsets are rejected', () => {
    for (const value of ['26/02/29,00:00:00+00', '26/13/01,00:00:00+00',
        '26/09/09,24:00:00+14', '26/09/09,16:02:37+99', '26/09/09,16:02:37-48',
        'garbage', {}, '2026-09-09T16:02:37']) assert.throws(() => parseSmsTimestamp(value));
});

test('webhook saves the reported timestamp and returns 400 before DB writes for malformed input', async t => {
    const saved = [];
    let dbReads = 0;
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.prisma = {
            simcard: { findUnique: async () => { dbReads++; return { iccid: 'test-sim' }; } },
            sms: { create: async ({ data }) => {
                assert.ok(data.timestamp instanceof Date && Number.isFinite(data.timestamp.getTime()));
                saved.push(data); return { id: 1, ...data };
            } }
        };
        next();
    });
    app.use('/webhook', webhook);
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const url = `http://127.0.0.1:${server.address().port}/webhook/sms`;
    const post = timestamp => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ iccid: 'test-sim', sender: '+980000', message: 'hi', timestamp }) });
    const good = await post('26/09/09,16:02:37+14');
    assert.equal(good.status, 200);
    assert.equal((await good.json()).sms.timestamp, '2026-09-09T12:32:37.000Z');
    const bad = await post('broken');
    assert.equal(bad.status, 400);
    await bad.json();
    assert.equal(saved.length, 1);
    assert.equal(dbReads, 1);
});
