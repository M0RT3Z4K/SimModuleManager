import React, { useEffect, useState } from 'react';
import { Save } from 'lucide-react';
import { api } from '../api';

export default function RecordingSettings({ devices, onChanged }) {
  const [settings, setSettings] = useState(null);
  const [message, setMessage] = useState('');
  useEffect(() => { api.get('/settings').then(({ data }) => setSettings(data)); }, []);
  const updateDevice = async (device, changes) => { await api.patch(`/devices/${device.id}`, changes); setMessage('تنظیم دستگاه ذخیره شد.'); onChanged(); };
  const saveProvider = async e => { e.preventDefault(); await api.patch('/settings/provider', settings.provider); setMessage('تنظیم provider ذخیره شد؛ کلید API فقط از محیط سرور خوانده می‌شود.'); };
  const savePolicy = async e => { e.preventDefault(); await api.patch('/settings/policy', settings.policy); setMessage('سیاست نگهداری ذخیره شد.'); };
  if (!settings) return <div className="muted">در حال دریافت تنظیمات…</div>;
  return (
    <div className="settings-stack" dir="rtl">
      {message && <div className="success-banner">{message}</div>}
      <section><h2>دریافت و پردازش هر دستگاه</h2><p className="section-help">نرخ ورودی باید از firmware اعلام شود. مقدار دستی 43904 فقط در صورت کالیبراسیون واقعی همان دستگاه انتخاب شود و نرخ TCP مبنای تغییر زنده نیست.</p>
        <div className="device-settings-grid">{devices.map(device => <DeviceSettings key={device.id} device={device} onSave={updateDevice}/>)}</div>
      </section>
      <form onSubmit={saveProvider}><h2>OpenAI-compatible transcription</h2><div className="settings-grid">
        <label>Base URL<input className="form-input" dir="ltr" value={settings.provider.base_url} onChange={e => setSettings({ ...settings, provider: { ...settings.provider, base_url: e.target.value } })}/></label>
        <label>Model<input className="form-input" dir="ltr" value={settings.provider.model} onChange={e => setSettings({ ...settings, provider: { ...settings.provider, model: e.target.value } })}/></label>
        <label>زبان<input className="form-input" value={settings.provider.language || ''} placeholder="fa یا خالی برای auto" onChange={e => setSettings({ ...settings, provider: { ...settings.provider, language: e.target.value || null } })}/></label>
        <label>Timeout (ms)<input className="form-input" type="number" value={settings.provider.timeout_ms} onChange={e => setSettings({ ...settings, provider: { ...settings.provider, timeout_ms: Number(e.target.value) } })}/></label>
        <label>هم‌زمانی<input className="form-input" type="number" min="1" value={settings.provider.concurrency} onChange={e => setSettings({ ...settings, provider: { ...settings.provider, concurrency: Number(e.target.value) } })}/></label>
        <label>حداکثر فایل (bytes)<input className="form-input" type="number" value={settings.provider.max_file_bytes} onChange={e => setSettings({ ...settings, provider: { ...settings.provider, max_file_bytes: Number(e.target.value) } })}/></label>
      </div><div className={settings.provider.api_key_configured ? 'success-text' : 'warning-text'}>{settings.provider.api_key_configured ? 'کلید API روی سرور تنظیم شده است.' : 'TRANSCRIPTION_API_KEY روی سرور تنظیم نشده است.'}</div><button className="btn btn-primary"><Save size={16}/> ذخیره provider</button></form>
      <form onSubmit={savePolicy}><h2>نگهداری و فضا</h2><div className="settings-grid">
        <label>Pre-roll (ms)<input className="form-input" type="number" value={settings.policy.pre_roll_ms} onChange={e => setSettings({ ...settings, policy: { ...settings.policy, pre_roll_ms: Number(e.target.value) } })}/></label>
        <label>روز نگهداری<input className="form-input" type="number" value={settings.policy.retention_days} onChange={e => setSettings({ ...settings, policy: { ...settings.policy, retention_days: Number(e.target.value) } })}/></label>
        <label>حداکثر فضای صوت (bytes)<input className="form-input" type="number" value={settings.policy.max_storage_bytes} onChange={e => setSettings({ ...settings, policy: { ...settings.policy, max_storage_bytes: Number(e.target.value) } })}/></label>
        <label className="check-label"><input type="checkbox" checked={settings.policy.delete_transcript} onChange={e => setSettings({ ...settings, policy: { ...settings.policy, delete_transcript: e.target.checked } })}/> حذف متن همراه صوت منقضی</label>
      </div><button className="btn btn-primary"><Save size={16}/> ذخیره سیاست</button></form>
    </div>
  );
}

function DeviceSettings({ device, onSave }) {
  const [form, setForm] = useState({ input_sample_rate: device.input_sample_rate || '', output_sample_rate: device.output_sample_rate, audio_profile: device.audio_profile, active: device.active, experimental_calibration: device.experimental_calibration });
  return <form className="device-setting-card" onSubmit={e => { e.preventDefault(); onSave(device, { ...form, input_sample_rate: Number(form.input_sample_rate) }); }}><h3>{device.label || device.id}</h3><span className={`receiver-state state-${device.receiver_status}`}>{device.receiver_status}</span>
    <label>نرخ ورودی<input className="form-input" type="number" placeholder="اعلام firmware" value={form.input_sample_rate} onChange={e => setForm({ ...form, input_sample_rate: e.target.value })}/></label>
    <label className="check-label"><input type="checkbox" checked={form.experimental_calibration} onChange={e => setForm({ ...form, experimental_calibration: e.target.checked })}/> کالیبراسیون آزمایشی</label>
    <label>نرخ خروجی<select className="form-input" value={form.output_sample_rate} onChange={e => setForm({ ...form, output_sample_rate: Number(e.target.value) })}>{[8000,16000,24000,32000,48000].map(rate => <option key={rate}>{rate}</option>)}</select></label>
    <label>پروفایل<select className="form-input" value={form.audio_profile} onChange={e => setForm({ ...form, audio_profile: e.target.value })}><option value="raw">خام (بدون حذف نویز)</option><option value="mild">شفاف‌سازی متعادل</option><option value="strong">شفاف‌سازی قوی</option></select></label>
    <label className="check-label"><input type="checkbox" checked={form.active} onChange={e => setForm({ ...form, active: e.target.checked })}/> receiver فعال</label><button className="btn btn-secondary">ذخیره</button>
  </form>;
}
