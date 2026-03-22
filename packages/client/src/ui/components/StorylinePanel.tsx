import React, { useState } from 'react';
import { requestWeeklySummary } from '../../network/socket';
import { COLORS, FONTS } from '../styles';

export const StorylinePanel: React.FC = () => {
  const [summary, setSummary] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleRequest = () => {
    setLoading(true);
    setSummary(null);
    requestWeeklySummary((result) => {
      setSummary(result || 'No events to summarize yet.');
      setLoading(false);
    });
  };

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
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
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
        <button
          onClick={handleRequest}
          disabled={loading}
          style={{
            padding: '6px 14px',
            background: loading ? COLORS.bgCard : '#a855f7',
            color: loading ? COLORS.textDim : '#fff',
            border: 'none',
            borderRadius: 4,
            cursor: loading ? 'default' : 'pointer',
            fontFamily: FONTS.pixel,
            fontSize: '8px',
            letterSpacing: 1,
          }}
        >
          {loading ? 'GENERATING...' : 'GENERATE'}
        </button>
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
            {loading
              ? 'Asking the narrator to summarize the week...'
              : 'Click GENERATE to get an LLM summary of what happened in the past 7 days.'}
          </div>
        )}
      </div>
    </div>
  );
};
