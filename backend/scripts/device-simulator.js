const http = require('node:http');
const crypto = require('node:crypto');

const panel = process.env.PANEL_URL || 'http://localhost:3001';
const deviceId = process.env.SIM_DEVICE_ID || 'simulator-001';
const deviceToken = process.env.SIM_DEVICE_TOKEN || 'simulator-device-token';
const registrationToken = process.env.DEVICE_REGISTRATION_TOKEN || '';
const sampleRate = Number(process.env.SIM_SAMPLE_RATE || 8000);
const port = Number(process.env.SIM_PORT || 8080);
let listener = null;
let sampleCounter = 0n;
let sequence = 0;
const bootId = crypto.randomUUID();
let activeTone = false;

const server = http.createServer((req, res) => {
    if (req.url === '/health') return void res.end(JSON.stringify({ status: 'ok', network: true, iccid: 'sim-iccid-001', audio_ready: true, audio_source: 'adc_gpio34' }));
    if (req.url !== '/') { res.statusCode = 404; return void res.end(); }
    if (listener) { res.statusCode = 409; return void res.end('one listener only'); }
    listener = res;
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'X-Audio-Session-Id': crypto.randomUUID(), 'X-Audio-Start-Sample': sampleCounter.toString() });
    req.on('close', () => { if (listener === res) listener = null; });
});

setInterval(() => {
    if (!listener) return;
    const samples = 160;
    const pcm = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i++) pcm.writeInt16LE(activeTone ? Math.round(7000 * Math.sin(Number(sampleCounter + BigInt(i)) * 2 * Math.PI * 440 / sampleRate)) : 0, i * 2);
    sampleCounter += BigInt(samples);
    // Deliberately split in the middle of 16-bit samples.
    const split = 101;
    listener.write(pcm.subarray(0, split));
    listener.write(pcm.subarray(split));
}, 20);

async function post(path, body, token) {
    const response = await fetch(`${panel}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
    return response.json();
}

async function event(callId, type, extra = {}) {
    return post(`/api/device-events/${deviceId}/events`, { boot_id: bootId, event_id: crypto.randomUUID(), sequence: sequence++, call_id: callId, type, sample_counter: sampleCounter.toString(), monotonic_ms: String(Math.floor(process.uptime() * 1000)), ...extra }, deviceToken);
}

server.listen(port, async () => {
    await post('/api/devices/register', { device_id: deviceId, device_token: deviceToken, call_events_version: 1, iccid: 'sim-iccid-001', ip: '127.0.0.1', phone: '+989120000000', audio: { format: 'pcm_s16le', channels: 1, sample_rate: sampleRate } }, registrationToken);
    console.log(`Device simulator listening on ${port}; a call starts in two seconds.`);
    setTimeout(async () => {
        const callId = crypto.randomUUID();
        await event(callId, 'ringing', { caller_number: '+989121234567' });
        await new Promise(resolve => setTimeout(resolve, 600));
        activeTone = true;
        await event(callId, 'answered');
        await new Promise(resolve => setTimeout(resolve, 4000));
        await event(callId, 'ended', { reason: 'remote_hangup' });
        activeTone = false;
        console.log(`Simulated call ${callId} ended.`);
    }, 2000);
});
