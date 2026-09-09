const http = require('node:http');
const port = Number(process.env.PROVIDER_SIM_PORT || 3099);
let failures = Number(process.env.PROVIDER_FAIL_FIRST || 0);

http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/audio/transcriptions') { res.statusCode = 404; return void res.end(); }
    let bytes = 0;
    req.on('data', chunk => { bytes += chunk.length; });
    req.on('end', () => {
        if (failures-- > 0) { res.writeHead(429, { 'content-type': 'application/json' }); return void res.end(JSON.stringify({ error: 'simulated rate limit' })); }
        if (!req.headers.authorization?.startsWith('Bearer ')) { res.statusCode = 401; return void res.end('missing token'); }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ text: `متن آزمایشی برای فایل ${bytes} بایتی` }));
    });
}).listen(port, () => console.log(`Provider simulator: http://localhost:${port}/v1`));
