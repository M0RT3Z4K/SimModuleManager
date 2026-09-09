#pragma once
#include <Arduino.h>

static const char LISTEN_PAGE[] PROGMEM = R"HTML(
<!doctype html><html lang="fa" dir="rtl"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>پخش زنده صدای تماس</title>
<style>body{font-family:sans-serif;max-width:640px;margin:60px auto;padding:24px;text-align:center}button{padding:14px 28px;font-size:18px;cursor:pointer}#log{margin:24px 0;line-height:1.8;overflow-wrap:anywhere}</style>
<h2>پخش زنده صدای تماس</h2>
<button id="btn">شروع پخش زنده</button><p id="log" role="status">آمادهٔ اتصال</p>
<p>ورودی صدا: GPIO34، مونو، ۸۰۰۰ نمونه در ثانیه</p>
<p>برای شنیدن تماس، خروجی صدای مودم باید از طریق مدار تطبیق صدا به GPIO34 وصل باشد. این صفحه صدای تماس را از UART دریافت نمی‌کند؛ ورودی بدون اتصال ممکن است فقط نویز پخش کند.</p>
<script>
const button = document.getElementById('btn');
const log = document.getElementById('log');
let active = null;
function stop(session) {
  if (!session || active !== session) return;
  active = null;
  session.controller.abort();
  clearInterval(session.watchdog);
  for (const source of session.sources) source.stop();
  session.sources.clear();
  if (session.context) session.context.close().catch(() => {});
  button.textContent = 'شروع پخش زنده';
}
button.onclick = async () => {
  if (active) { stop(active); log.textContent = 'پخش متوقف شد.'; return; }
  const session = { controller: new AbortController(), sources: new Set(), lastData: Date.now() };
  active = session;
  button.textContent = 'توقف پخش';
  log.textContent = 'در حال اتصال…';
  try {
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) throw new Error('مرورگر از پخش زنده پشتیبانی نمی‌کند.');
    // Use the output device's native rate. AudioBufferSource resamples 8 kHz PCM.
    session.context = new Context();
    await session.context.resume();
    if (active !== session) return;
    session.watchdog = setInterval(() => {
      if (Date.now() - session.lastData > 10000) {
        stop(session);
        log.textContent = 'داده‌ای دریافت نشد؛ اتصال شبکه و برد را بررسی کنید.';
      }
    }, 1000);
    const response = await fetch('http://' + location.hostname + ':8080/', {
      signal: session.controller.signal, cache: 'no-store'
    });
    if (!response.ok) throw new Error(response.status === 409 ? 'پخش در یک صفحهٔ دیگر باز است؛ ابتدا آن را متوقف کنید.' : 'خطای سرور: ' + response.status);
    if (!response.body) throw new Error('دریافت استریم در این مرورگر پشتیبانی نمی‌شود.');
    const reader = response.body.getReader();
    let pendingByte = null;
    let samples = new Float32Array(1024), used = 0;
    let nextTime = 0, totalBytes = 0, peak = 0, lastDisplay = 0;
    const schedule = () => {
      const ctx = session.context;
      if (ctx.state !== 'running') throw new Error('پخش مرورگر تعلیق شده؛ دوباره شروع کنید.');
      if (nextTime > ctx.currentTime + 0.6) return; // Bound latency when a network burst arrives.
      nextTime = Math.max(nextTime, ctx.currentTime + 0.08);
      const buffer = ctx.createBuffer(1, samples.length, 8000);
      buffer.copyToChannel(samples, 0);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      session.sources.add(source);
      source.onended = () => { session.sources.delete(source); source.disconnect(); };
      source.start(nextTime);
      nextTime += buffer.duration;
    };
    while (active === session) {
      const { value, done } = await reader.read();
      if (active !== session) return;
      if (done) throw new Error('اتصال صدا بسته شد؛ دوباره شروع کنید.');
      session.lastData = Date.now();
      totalBytes += value.length;
      for (const byte of value) {
        if (pendingByte === null) { pendingByte = byte; continue; }
        let word = pendingByte | (byte << 8);
        pendingByte = null;
        if (word >= 32768) word -= 65536;
        const sample = word / 32768;
        peak = Math.max(peak, Math.abs(sample));
        samples[used++] = sample;
        if (used === samples.length) { schedule(); used = 0; }
      }
      if (Date.now() - lastDisplay > 500) {
        log.textContent = 'دریافت: ' + Math.round(totalBytes / 1024) + ' KB — ' +
          (peak < 0.005 ? 'سیگنال بسیار ضعیف؛ ورودی صدا و تماس را بررسی کنید.' : 'در حال پخش؛ سطح سیگنال ' + Math.round(peak * 100) + '٪');
        peak = 0;
        lastDisplay = Date.now();
      }
    }
  } catch (error) {
    if (active === session) {
      stop(session);
      log.textContent = 'پخش انجام نشد: ' + error.message;
    }
  }
};
window.addEventListener('pagehide', () => stop(active));
</script></html>
)HTML";
