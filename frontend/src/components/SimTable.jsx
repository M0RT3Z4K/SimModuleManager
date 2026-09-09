import React from 'react';
import { ContactRound, MessageSquare, Send } from 'lucide-react';

const SimTable = ({ simcards, onViewHistory, onSendSms, onViewContacts }) => {
  return (
    <div className="table-wrapper">
      <table>
        <thead>
          <tr>
            <th>ICCID</th>
            <th>Phone Number</th>
            <th>IP Address</th>
            <th>Last Seen</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {simcards.length === 0 ? (
            <tr>
              <td colSpan="6" style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)' }}>
                No SIM cards found.
              </td>
            </tr>
          ) : (
            simcards.map(sim => (
              <tr key={sim.iccid}>
                <td style={{ fontFamily: 'monospace' }}>{sim.iccid}</td>
                <td>{sim.phone_number || 'Unknown'}</td>
                <td>{sim.ip_address || 'N/A'}</td>
                <td>{sim.last_seen ? new Date(sim.last_seen).toLocaleString() : 'Never'}</td>
                <td>
                  <span className={`status-indicator status-${sim.status}`}>
                    <span className="status-dot"></span>
                    {sim.status.charAt(0).toUpperCase() + sim.status.slice(1)}
                  </span>
                </td>
                <td style={{ display: 'flex', gap: '0.5rem' }}>
                  <button className="btn btn-secondary" onClick={() => onViewHistory(sim)}>
                    <MessageSquare size={16} />
                    History
                  </button>
                  <button className="btn btn-secondary" onClick={() => onViewContacts(sim)} disabled={!sim.deviceId}>
                    <ContactRound size={16} />
                    Contacts
                  </button>
                  <button 
                    className="btn btn-primary" 
                    onClick={() => onSendSms(sim)}
                    disabled={sim.status !== 'online'}
                  >
                    <Send size={16} />
                    Send
                  </button>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
};

export default SimTable;
