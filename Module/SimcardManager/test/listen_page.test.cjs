// Run with: node --test test/listen_page.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '../src/listen_page.h'), 'utf8');
const script = html.split('<script>')[1].split('</script>')[0];
function setup(chunks, status = 200) {
  const button = {}, log = {}, buffers = [];
  let closed = false, resumed = false;
  class Context {
    constructor(options) { assert.equal(options, undefined); this.currentTime = 0; this.state = 'suspended'; }
    async resume() { resumed = true; this.state = 'running'; }
    async close() { closed = true; }
    createBuffer(channels, length, rate) {
      assert.equal(channels, 1); assert.equal(rate, 8000);
      return { duration: length / rate, copyToChannel: data => buffers.push(Array.from(data)) };
    }
    createBufferSource() { return { connect() {}, disconnect() {}, start() {}, stop() {} }; }
  }
  const sandbox = {
    document: { getElementById: id => id === 'btn' ? button : log },
    window: { AudioContext: Context, addEventListener() {} },
    location: { hostname: 'device' }, AbortController, setInterval, clearInterval,
    fetch: async () => {
      assert.equal(resumed, true);
      return { ok: status === 200, status, body: { getReader: () => ({
        read: async () => chunks.length ? { value: chunks.shift(), done: false } : { done: true }
      }) } };
    }
  };
  vm.runInNewContext(script, sandbox);
  return { button, log, buffers, isClosed: () => closed };
}
test('PCM16LE survives odd network boundaries and uses 8 kHz buffers on native output context', async () => {
  const bytes = Buffer.alloc(2048);
  for (let i = 0; i < 1024; i++) bytes.writeInt16LE(i % 2 ? 16384 : -16384, i * 2);
  const app = setup([bytes.subarray(0, 1), bytes.subarray(1, 77), bytes.subarray(77)]);
  await app.button.onclick();
  assert.equal(app.buffers.length, 1);
  assert.equal(app.buffers[0].length, 1024);
  app.buffers[0].forEach((sample, i) => assert.equal(sample, i % 2 ? 0.5 : -0.5));
  assert.equal(app.isClosed(), true);
  assert.match(app.log.textContent, /اتصال صدا بسته شد/);
  assert.equal(app.button.textContent, 'شروع پخش زنده');
});
test('server rejection is shown and context cleaned up', async () => {
  const app = setup([], 409);
  await app.button.onclick();
  assert.match(app.log.textContent, /صفحهٔ دیگر/);
  assert.equal(app.isClosed(), true);
  assert.equal(app.buffers.length, 0);
});
