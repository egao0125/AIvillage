import React, { useState } from 'react';
import { EventFeed } from './EventFeed';
import { COLORS, FONTS } from '../styles';

interface EventFeedButtonProps {
  chatOpen?: boolean;
}

export const EventFeedButton: React.FC<EventFeedButtonProps> = ({ chatOpen }) => {
  const [open, setOpen] = useState(false);

  return (
    <>
      {/* Teal event feed button — next to purple feed button */}
      <button
        onClick={() => setOpen(prev => !prev)}
        style={{
          position: 'fixed',
          bottom: 20,
          left: 132,
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
          boxShadow: `0 2px 12px ${COLORS.accent}66`,
          zIndex: 1000,
        }}
      >
        ⚡
      </button>

      {/* Event feed panel overlay */}
      {open && (
        <div
          style={{
            position: 'fixed',
            bottom: 80,
            left: chatOpen ? 330 : 20,
            width: 380,
            height: 500,
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
            <span style={{ fontFamily: FONTS.pixel, fontSize: '9px', color: COLORS.accent, letterSpacing: 1 }}>
              EVENT FEED
            </span>
            <button
              onClick={() => setOpen(false)}
              style={{
                background: 'none',
                border: 'none',
                color: COLORS.textDim,
                cursor: 'pointer',
                fontSize: '14px',
                fontFamily: FONTS.body,
              }}
            >
              ✕
            </button>
          </div>

          {/* Feed content */}
          <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
            <EventFeed />
          </div>
        </div>
      )}
    </>
  );
};
