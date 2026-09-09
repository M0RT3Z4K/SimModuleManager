import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../api';
import { X, ChevronLeft, ChevronRight } from 'lucide-react';

const SmsHistoryModal = ({ simcard, onClose }) => {
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  const fetchMessages = useCallback(async (currentPage) => {
    setLoading(true);
    try {
      const response = await api.get(`/simcards/${simcard.iccid}/sms?page=${currentPage}&limit=20`);
      setMessages(response.data.data);
      setTotalPages(response.data.pagination.totalPages);
    } catch (error) {
      console.error('Failed to fetch messages', error);
    } finally {
      setLoading(false);
    }
  }, [simcard.iccid]);

  useEffect(() => {
    const initial = setTimeout(() => fetchMessages(page), 0);
    return () => clearTimeout(initial);
  }, [page, fetchMessages]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content glass-panel" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2 style={{ fontSize: '1.25rem', fontWeight: 600 }}>SMS History ({simcard.iccid})</h2>
          <button className="modal-close" onClick={onClose}><X size={20} /></button>
        </div>

        <div className="chat-container">
          {loading ? (
            <div style={{ textAlign: 'center', color: 'var(--text-muted)' }}>Loading...</div>
          ) : messages.length === 0 ? (
            <div style={{ textAlign: 'center', color: 'var(--text-muted)' }}>No messages found.</div>
          ) : (
            // Reversing just for display so newest is at the bottom, or keep as is.
            // Based on API it's descending. Let's keep it descending (newest top).
            messages.map(msg => (
              <div key={msg.id} className={`chat-bubble ${msg.direction}`}>
                <div style={{ wordBreak: 'break-word' }}>{msg.message_text}</div>
                <div className="chat-meta">
                  <span>{msg.direction === 'incoming' ? 'From: ' : 'To: '} {msg.sender_number}</span>
                  <span>{new Date(msg.timestamp).toLocaleString()}</span>
                </div>
              </div>
            ))
          )}
        </div>

        {totalPages > 1 && (
          <div className="pagination">
            <button 
              className="btn btn-secondary" 
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page === 1}
            >
              <ChevronLeft size={16} /> Prev
            </button>
            <span>Page {page} of {totalPages}</span>
            <button 
              className="btn btn-secondary" 
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
            >
              Next <ChevronRight size={16} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default SmsHistoryModal;
