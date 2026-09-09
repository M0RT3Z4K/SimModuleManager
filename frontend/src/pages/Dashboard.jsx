import React, { useCallback, useEffect, useState } from 'react';
import { Activity, MessageSquare, PhoneCall, Settings } from 'lucide-react';
import { api } from '../api';
import SimTable from '../components/SimTable';
import SmsHistoryModal from '../components/SmsHistoryModal';
import SendSmsModal from '../components/SendSmsModal';
import CallsPanel from '../components/CallsPanel';
import RecordingSettings from '../components/RecordingSettings';
import ContactsModal from '../components/ContactsModal';

const Dashboard = () => {
  const [simcards, setSimcards] = useState([]);
  const [devices, setDevices] = useState([]);
  const [selectedSimForSms, setSelectedSimForSms] = useState(null);
  const [selectedSimForSend, setSelectedSimForSend] = useState(null);
  const [selectedSimForContacts, setSelectedSimForContacts] = useState(null);
  const [tab, setTab] = useState('simcards');
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      const [sims, deviceList] = await Promise.all([api.get('/simcards'), api.get('/devices')]);
      setSimcards(sims.data); setDevices(deviceList.data); setError('');
    } catch (e) { setError(e.response?.status === 401 ? 'برای دسترسی، توکن کاربر را در VITE_API_TOKEN یا sessionStorage تنظیم کنید.' : 'ارتباط با backend برقرار نشد.'); }
  }, []);

  useEffect(() => { const initial = setTimeout(refresh, 0); const interval = setInterval(refresh, 10000); return () => { clearTimeout(initial); clearInterval(interval); }; }, [refresh]);

  return (
    <div className="container">
      <header className="topbar"><h1><Activity size={32}/> Simcard Manager</h1><nav>
        <button className={tab === 'simcards' ? 'active' : ''} onClick={() => setTab('simcards')}><MessageSquare size={17}/> سیم‌کارت‌ها</button>
        <button className={tab === 'calls' ? 'active' : ''} onClick={() => setTab('calls')}><PhoneCall size={17}/> تماس‌ها</button>
        <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}><Settings size={17}/> تنظیمات ضبط</button>
      </nav></header>
      {error && <div className="warning-banner" dir="rtl">{error}</div>}
      <div className="glass-panel main-panel">
        {tab === 'simcards' && <SimTable simcards={simcards} onViewHistory={setSelectedSimForSms} onSendSms={setSelectedSimForSend} onViewContacts={setSelectedSimForContacts}/>} 
        {tab === 'calls' && <CallsPanel devices={devices}/>} 
        {tab === 'settings' && <RecordingSettings devices={devices} onChanged={refresh}/>} 
      </div>
      {selectedSimForSms && <SmsHistoryModal simcard={selectedSimForSms} onClose={() => setSelectedSimForSms(null)}/>} 
      {selectedSimForSend && <SendSmsModal simcard={selectedSimForSend} onClose={() => setSelectedSimForSend(null)}/>} 
      {selectedSimForContacts && <ContactsModal simcard={selectedSimForContacts} onClose={() => setSelectedSimForContacts(null)}/>} 
    </div>
  );
};

export default Dashboard;
