import React from 'react';
import { useWeeklySummary } from '../../core/hooks';
import { COLORS, FONTS } from '../styles';

export const StorylinePanel: React.FC = () => {
  const summary = useWeeklySummary();

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        padding: '16px 18px',
      }}
    >
      {/* Header */}
      <div
        style={{
          marginBottom: 16,
        }}
      >
        <span
          style={{
            fontFamily: FONTS.pixel,
            fontSize: '10px',
            color: '#ffd700',
            letterSpacing: 2,
          }}
        >
          WEEKLY RECAP
        </span>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        {summary ? (
          <div
            style={{
              fontFamily: FONTS.body,
              fontSize: '14px',
              color: COLORS.text,
              lineHeight: 1.7,
              whiteSpace: 'pre-wrap',
            }}
          >
            {summary}
          </div>
        ) : (
          <div
            style={{
              textAlign: 'center',
              color: COLORS.textDim,
              fontFamily: FONTS.body,
              fontSize: '14px',
              fontStyle: 'italic',
              paddingTop: 40,
            }}
          >
            The weekly recap will appear here automatically every 7 game days.
          </div>
        )}
      </div>
    </div>
  );
};
