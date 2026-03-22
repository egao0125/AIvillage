import React, { useState } from 'react';
import { ChatLog } from './ChatLog';
import { COLORS, FONTS } from '../styles';

interface FeedButtonProps {
  chatOpen?: boolean;
}

export const FeedButton: React.FC<FeedButtonProps> = ({ chatOpen }) => {
  const [open, setOpen] = useState(false);

  return (
    <>
      {/* Purple feed button — next to spectator chat */}
      <button
        onClick={() => setOpen(prev => !prev)}
        style={{
          position: 'fixed',
          bottom: 20,
          left: 76,
          width: 48,
          height: 48,
          borderRadius: '50%',
          background: '#a855f7',
          border: 'none',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '20px',
          boxShadow: '0 2px 12px rgba(168, 85, 247, 0.4)',
          zIndex: 1000,
        }}
      >
        {'\u{1F4E2}'}
      </button>

      {/* Feed panel overlay */}
      {open && (
        <div
          style={{
            position: 'fixed',
            bottom: 80,
            left: chatOpen ? 330 : 20,
            width: 340,
            height: 450,
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
            <span style={{ fontFamily: FONTS.pixel, fontSize: '9px', color: '#a855f7', letterSpacing: 1 }}>
              VILLAGE FEED
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
              {'\u2715'}
            </button>
          </div>

          {/* Feed content */}
          <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
            <ChatLog />
          </div>
        </div>
      )}
    </>
  );
};
