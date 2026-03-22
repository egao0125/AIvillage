import React, { useState, useEffect, useRef } from 'react';
import { eventBus } from '../../core/EventBus';
import { sendSpectatorComment } from '../../network/socket';
import { COLORS, FONTS } from '../styles';

interface SpectatorMessage {
  id: string;
  name: string;
  message: string;
  timestamp: number;
}

interface SpectatorChatProps {
  onOpenChange?: (open: boolean) => void;
}

export const SpectatorChat: React.FC<SpectatorChatProps> = ({ onOpenChange }) => {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<SpectatorMessage[]>([]);
  const [input, setInput] = useState('');
  const [unread, setUnread] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (data: { name: string; message: string; timestamp: number }) => {
      const msg: SpectatorMessage = {
        id: crypto.randomUUID(),
        name: data.name,
        message: data.message,
        timestamp: data.timestamp,
      };
      setMessages(prev => [...prev.slice(-49), msg]);
      if (!open) setUnread(prev => prev + 1);
    };

    eventBus.on('spectator:comment', handler);
    return () => { eventBus.off('spectator:comment', handler); };
  }, [open]);

  useEffect(() => {
    if (open && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, open]);

  const handleSend = () => {
    const msg = input.trim();
    if (!msg) return;
    sendSpectatorComment(msg);
    setInput('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const toggleOpen = () => {
    const next = !open;
    setOpen(next);
    onOpenChange?.(next);
    if (next) setUnread(0);
  };

  return (
    <>
      {/* Floating chat button — bottom-left */}
      <button
        onClick={toggleOpen}
        style={{
          position: 'fixed',
          bottom: 20,
          left: 20,
          width: 48,
          height: 48,
          borderRadius: '50%',
          background: COLORS.accent,
          border: 'none',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '20px',
          boxShadow: '0 2px 12px rgba(0,0,0,0.4)',
          zIndex: 1000,
        }}
      >
        {'\u{1F4AC}'}
        {unread > 0 && (
          <span style={{
            position: 'absolute',
            top: -4,
            right: -4,
            background: '#ef4444',
            color: '#fff',
            fontSize: '10px',
            fontFamily: FONTS.pixel,
            width: 20,
            height: 20,
            borderRadius: '50%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}>
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {/* Chat panel overlay */}
      {open && (
        <div
          style={{
            position: 'fixed',
            bottom: 80,
            left: 20,
            width: 300,
            height: 400,
            background: COLORS.bg,
            border: `1px solid ${COLORS.border}`,
            borderRadius: 8,
            display: 'flex',
            flexDirection: 'column',
            boxShadow: '0 4px 24px rgba(0,0,0,0.5)',
            zIndex: 1000,
            overflow: 'hidden',
          }}
        >
          {/* Header */}
          <div style={{
            padding: '10px 14px',
            borderBottom: `1px solid ${COLORS.border}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}>
            <span style={{ fontFamily: FONTS.pixel, fontSize: '9px', color: COLORS.textAccent, letterSpacing: 1 }}>
              SPECTATOR CHAT
            </span>
            <button
              onClick={toggleOpen}
              style={{
                background: 'none',
                border: 'none',
                color: COLORS.textDim,
                cursor: 'pointer',
                fontSize: '14px',
                fontFamily: FONTS.body,
              }}
            >
              {'\u2715'}
            </button>
          </div>

          {/* Messages */}
          <div
            ref={scrollRef}
            style={{
              flex: 1,
              overflowY: 'auto',
              padding: '8px 12px',
              minHeight: 0,
            }}
          >
            {messages.length === 0 ? (
              <div style={{ color: COLORS.textDim, fontSize: '12px', textAlign: 'center', padding: 20, fontFamily: FONTS.body }}>
                No messages yet. Say something!
              </div>
            ) : (
              messages.map(msg => (
                <div key={msg.id} style={{ marginBottom: 6 }}>
                  <span style={{
                    fontSize: '10px',
                    padding: '1px 5px',
                    borderRadius: 3,
                    background: '#6366f1',
                    color: '#fff',
                    fontFamily: FONTS.pixel,
                    marginRight: 6,
                  }}>
                    {msg.name}
                  </span>
                  <span style={{ color: COLORS.text, fontSize: '12px', fontFamily: FONTS.body }}>
                    {msg.message}
                  </span>
                </div>
              ))
            )}
          </div>

          {/* Input */}
          <div style={{
            padding: '8px 10px',
            borderTop: `1px solid ${COLORS.border}`,
            display: 'flex',
            gap: 6,
          }}>
            <input
              type="text"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type a message..."
              maxLength={200}
              style={{
                flex: 1,
                padding: '6px 10px',
                background: COLORS.bgCard,
                border: `1px solid ${COLORS.border}`,
                borderRadius: 4,
                color: COLORS.text,
                fontSize: '12px',
                fontFamily: FONTS.body,
                outline: 'none',
              }}
            />
            <button
              onClick={handleSend}
              style={{
                padding: '6px 12px',
                background: COLORS.accent,
                color: '#000',
                border: 'none',
                borderRadius: 4,
                cursor: 'pointer',
                fontFamily: FONTS.pixel,
                fontSize: '8px',
                fontWeight: 'bold',
              }}
            >
              SEND
            </button>
          </div>
        </div>
      )}
    </>
  );
};
