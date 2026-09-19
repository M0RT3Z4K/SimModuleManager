import React, { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { api } from '../api';

export default function AudioAsset({ callId, variant, label, revision = '' }) {
  const [url, setUrl] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    let objectUrl;
    setUrl(null);
    setError('');
    api.get(`/calls/${callId}/audio/${variant}`, { responseType: 'blob' })
      .then(({ data }) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(data);
        setUrl(objectUrl);
      })
      .catch(() => active && setError('فایل صوتی قابل دریافت نیست.'));
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [callId, variant, revision]);

  if (error) return <div className="inline-error">{error}</div>;
  if (!url) return <div className="muted">در حال دریافت {label}…</div>;
  return (
    <div className="audio-asset">
      <strong>{label}</strong>
      <audio controls preload="metadata" src={url} />
      <a className="btn btn-secondary" href={url} download={`${callId}-${variant}.wav`}><Download size={15} /> دانلود</a>
    </div>
  );
}
