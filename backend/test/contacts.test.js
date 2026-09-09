const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { PrismaClient } = require('@prisma/client');
const simcardRoutes = require('../src/routes/simcard');
const { normalizeContacts, fetchDeviceContacts } = require('../src/services/deviceContacts');

async function listen(server) {
    server.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    return server.address().port;
}

test('contact payload validation rejects malformed records', () => {
    assert.deepEqual(normalizeContacts({ contacts: [{ name: ' علی ', phone: ' 0912 ' }] }), [{ name: 'علی', phone: '0912' }]);
    for (const value of [null, {}, { contacts: {} }, { contacts: [{ name: 'x' }] }, { contacts: [{ name: 'x', phone: '' }] }]) assert.throws(() => normalizeContacts(value));
});

test('device contact client handles valid JSON, non-2xx, invalid JSON, and timeout', async t => {
    let mode = 'valid';
    const device = http.createServer((req, res) => {
        if (mode === 'timeout') return;
        if (mode === 'http') { res.statusCode = 503; return void res.end('busy'); }
        res.setHeader('content-type', 'application/json');
        res.end(mode === 'invalid' ? '{broken' : JSON.stringify({ contacts: [{ name: 'A', phone: '1' }] }));
    });
    const port = await listen(device);
    t.after(() => new Promise(resolve => device.close(resolve)));
    assert.deepEqual(await fetchDeviceContacts(`127.0.0.1:${port}`, 1000), [{ name: 'A', phone: '1' }]);
    mode = 'http'; await assert.rejects(fetchDeviceContacts(`127.0.0.1:${port}`, 1000), error => error.code === 'CONTACTS_HTTP_ERROR');
    mode = 'invalid'; await assert.rejects(fetchDeviceContacts(`127.0.0.1:${port}`, 1000), error => error.code === 'INVALID_CONTACTS_JSON');
    mode = 'timeout'; await assert.rejects(fetchDeviceContacts(`127.0.0.1:${port}`, 25), error => error.code === 'CONTACTS_TIMEOUT');
});

test('backend stores contacts per current SIM ICCID and preserves cache on device failure', async t => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'simcard-contacts-db-'));
    const dbUrl = `file:${path.join(tempDir, 'test.db')}`;
    execFileSync(path.resolve(__dirname, '../node_modules/.bin/prisma'), ['db', 'execute', '--url', dbUrl, '--file', path.resolve(__dirname, '../prisma/test-schema.sql')], { env: process.env, stdio: 'ignore' });
    const prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });
    let firstValid = true;
    const firstDevice = http.createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(firstValid ? JSON.stringify({ contacts: [{ name: 'Ali', phone: '111' }] }) : '{bad'); });
    const secondDevice = http.createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ contacts: [{ name: 'Sara', phone: '222' }] })); });
    const [firstPort, secondPort] = await Promise.all([listen(firstDevice), listen(secondDevice)]);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.prisma = prisma; req.auth = { role: 'admin', deviceIds: null }; next(); });
    app.use('/api/simcards', simcardRoutes);
    const api = http.createServer(app);
    const apiPort = await listen(api);
    t.after(async () => {
        await Promise.all([new Promise(resolve => firstDevice.close(resolve)), new Promise(resolve => secondDevice.close(resolve)), new Promise(resolve => api.close(resolve))]);
        await prisma.$disconnect(); fs.rmSync(tempDir, { recursive: true });
    });
    await prisma.device.createMany({ data: [{ id: 'd1', ip_address: `127.0.0.1:${firstPort}` }, { id: 'd2', ip_address: `127.0.0.1:${secondPort}` }] });
    await prisma.simcard.createMany({ data: [{ iccid: 'sim-1', deviceId: 'd1' }, { iccid: 'sim-2', deviceId: 'd2' }] });
    const get = iccid => fetch(`http://127.0.0.1:${apiPort}/api/simcards/${iccid}/contacts`);
    assert.equal((await get('sim-1')).status, 200);
    assert.equal((await get('sim-2')).status, 200);
    assert.deepEqual((await prisma.contact.findMany({ where: { simcardId: 'sim-1' } })).map(c => c.phone), ['111']);
    assert.deepEqual((await prisma.contact.findMany({ where: { simcardId: 'sim-2' } })).map(c => c.phone), ['222']);
    firstValid = false;
    const failed = await get('sim-1');
    assert.equal(failed.status, 502);
    const body = await failed.json();
    assert.equal(body.stale, true); assert.deepEqual(body.cached_contacts.map(c => c.phone), ['111']);
    assert.deepEqual((await prisma.contact.findMany({ where: { simcardId: 'sim-2' } })).map(c => c.phone), ['222']);
});
