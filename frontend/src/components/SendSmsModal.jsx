import React, { useState } from 'react';
import { api } from '../api';
import { X, Send } from 'lucide-react';

const SendSmsModal = ({ simcard, onClose }) => {
  const [phone, setPhone] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!phone || !message) return;

    setLoading(true);
    setError(null);
    setSuccess(false);

    try {
      await api.post(`/simcards/${simcard.iccid}/send`, {
        phone,
        message
      });
      setSuccess(true);
      setTimeout(() => onClose(), 2000);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to send SMS');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content glass-panel" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2 style={{ fontSize: '1.25rem', fontWeight: 600 }}>Send SMS ({simcard.iccid})</h2>
          <button className="modal-close" onClick={onClose}><X size={20} /></button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Recipient Phone Number</label>
            <input 
              type="text" 
              className="form-input" 
              value={phone} 
              onChange={e => setPhone(e.target.value)}
              placeholder="+1234567890"
              required
            />
          </div>
          
          <div className="form-group">
            <label>Message</label>
            <textarea 
              className="form-input" 
              rows="4" 
              value={message}
              onChange={e => setMessage(e.target.value)}
              placeholder="Type your message here..."
              required
            ></textarea>
          </div>

          {error && <div style={{ color: 'var(--danger)', marginBottom: '1rem', fontSize: '0.875rem' }}>{error}</div>}
          {success && <div style={{ color: 'var(--success)', marginBottom: '1rem', fontSize: '0.875rem' }}>Message sent successfully!</div>}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
            <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={loading}>
              <Send size={16} />
              {loading ? 'Sending...' : 'Send Message'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default SendSmsModal;
