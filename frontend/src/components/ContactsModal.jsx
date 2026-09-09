import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ContactRound, RefreshCw, Search, X } from 'lucide-react';
import { api } from '../api';

export default function ContactsModal({ simcard, onClose }) {
  const [contacts, setContacts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const [fetchedAt, setFetchedAt] = useState(null);
  const [query, setQuery] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const { data } = await api.get(`/simcards/${encodeURIComponent(simcard.iccid)}/contacts`);
      setContacts(data.contacts); setStale(false); setFetchedAt(data.fetched_at);
    } catch (requestError) {
      const data = requestError.response?.data;
      setContacts(data?.cached_contacts || []); setStale(Boolean(data?.cached_contacts));
      setFetchedAt(data?.cached_contacts?.[0]?.fetched_at || null);
      setError(data?.error || 'دریافت مخاطبان از دستگاه ناموفق بود.');
    } finally { setLoading(false); }
  }, [simcard.iccid]);

  useEffect(() => { const initial = setTimeout(load, 0); return () => clearTimeout(initial); }, [load]);
  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('fa');
    return needle ? contacts.filter(contact => `${contact.name} ${contact.phone}`.toLocaleLowerCase('fa').includes(needle)) : contacts;
  }, [contacts, query]);

  return <div className="modal-overlay" onMouseDown={event => event.target === event.currentTarget && onClose()}>
    <div className="modal-content glass-panel contacts-modal" dir="rtl">
      <div className="modal-header"><div><h2>مخاطبان سیم‌کارت</h2><small className="muted" dir="ltr">{simcard.iccid}</small></div><button className="modal-close" onClick={onClose}><X/></button></div>
      <div className="contacts-toolbar"><div className="search-box"><Search size={16}/><input value={query} onChange={event => setQuery(event.target.value)} placeholder="جست‌وجوی نام یا شماره"/></div><button className="btn btn-secondary" onClick={load} disabled={loading}><RefreshCw size={16}/>{loading ? 'در حال خواندن SIM800…' : 'دریافت مجدد'}</button></div>
      {error && <div className="warning-banner">{error}{stale && ' — آخرین نسخه ذخیره‌شده نمایش داده می‌شود.'}</div>}
      {fetchedAt && <div className="contacts-meta">آخرین دریافت: {new Date(fetchedAt).toLocaleString('fa-IR')}</div>}
      <div className="contacts-list">
        {loading && !contacts.length ? <div className="empty"><ContactRound/> خواندن مخاطبان ممکن است تا ۱۵ ثانیه طول بکشد…</div> : !visible.length ? <div className="empty"><ContactRound/> مخاطبی پیدا نشد.</div> : visible.map((contact, index) => <div className="contact-row" key={`${contact.phone}-${contact.name}-${index}`}><div className="contact-avatar"><ContactRound size={18}/></div><div><strong>{contact.name || 'بدون نام'}</strong><span dir="ltr">{contact.phone}</span></div></div>)}
      </div>
    </div>
  </div>;
}
