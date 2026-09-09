const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { PrismaClient } = require('@prisma/client');
const { applyCallEvent } = require('../src/services/callEvents');

test('duplicate, late, missed, and back-to-back lifecycle events are idempotent', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'simcard-db-'));
    const dbPath = path.join(dir, 'test.db');
    const dbUrl = `file:${dbPath}`;
    execFileSync(path.resolve(__dirname, '../node_modules/.bin/prisma'), ['db', 'execute', '--url', dbUrl, '--file', path.resolve(__dirname, '../prisma/test-schema.sql')], { env: process.env, stdio: 'ignore' });
    const prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });
    try {
        const device = await prisma.device.create({ data: { id: 'device-a', input_sample_rate: 8000 } });
        await prisma.simcard.create({ data: { iccid: 'iccid-a', phone_number: '+98111', deviceId: device.id } });
        const ring = { boot_id: 'boot', event_id: 'e1', sequence: 1, call_id: 'call-1', type: 'ringing', caller_number: '+98222', sample_counter: '100' };
        const first = await applyCallEvent(prisma, device, ring);
        const duplicate = await applyCallEvent(prisma, device, ring);
        assert.equal(first.duplicate, false); assert.equal(duplicate.duplicate, true);
        await applyCallEvent(prisma, device, { ...ring, event_id: 'e2', sequence: 2, type: 'answered', sample_counter: '200' });
        await applyCallEvent(prisma, device, { ...ring, event_id: 'e3', sequence: 3, type: 'ended', reason: 'remote_hangup', sample_counter: '8200' });
        await applyCallEvent(prisma, device, { ...ring, event_id: 'e4', sequence: 4, type: 'ringing' });
        const ended = await prisma.call.findUnique({ where: { id: first.call.id } });
        assert.equal(ended.state, 'ended'); assert.equal(ended.sim_iccid_snapshot, 'iccid-a');
        await applyCallEvent(prisma, device, { boot_id: 'boot', event_id: 'e5', sequence: 5, call_id: 'call-2', type: 'ringing' });
        await applyCallEvent(prisma, device, { boot_id: 'boot', event_id: 'e6', sequence: 6, call_id: 'call-2', type: 'ended', reason: 'rejected' });
        const missed = await prisma.call.findUnique({ where: { deviceId_boot_id_external_call_id: { deviceId: device.id, boot_id: 'boot', external_call_id: 'call-2' } } });
        assert.equal(missed.state, 'missed'); assert.equal(missed.recording_status, 'none');
        await applyCallEvent(prisma, device, { boot_id: 'boot', event_id: 'e7', sequence: 7, call_id: 'call-3', type: 'ended', reason: 'remote_hangup', sample_counter: '9000' });
        await applyCallEvent(prisma, device, { boot_id: 'boot', event_id: 'e8', sequence: 8, call_id: 'call-3', type: 'answered', sample_counter: '1000' });
        const late = await prisma.call.findUnique({ where: { deviceId_boot_id_external_call_id: { deviceId: device.id, boot_id: 'boot', external_call_id: 'call-3' } } });
        assert.equal(late.state, 'ended'); assert.equal(late.duration_ms, 1000); assert.equal(late.recording_incomplete, true);
        await applyCallEvent(prisma, device, { boot_id: 'boot', event_id: 'e9', sequence: 9, type: 'state', state: 'idle', sample_counter: '9100' });
        assert.equal(await prisma.call.count(), 3); assert.equal(await prisma.callEvent.count(), 9);
    } finally { await prisma.$disconnect(); fs.rmSync(dir, { recursive: true }); }
});
