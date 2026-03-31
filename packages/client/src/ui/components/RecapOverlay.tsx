import React from 'react';
import { useActiveRecap, useAgents } from '../../core/hooks';
import { gameStore } from '../../core/GameStore';
import { nameToColor, hexToString } from '../../utils/color';
import { FONTS } from '../styles';

export const RecapOverlay: React.FC = () => {
  const recap = useActiveRecap();
  const agents = useAgents();

  if (!recap) return null;

  const dismiss = () => {
    gameStore.setActiveRecap(null);
    const time = gameStore.getState().time;
    try {
      // Use sessionStorage (tab-scoped) — consistent with socket.ts which reads
      // from sessionStorage. localStorage would persist across sessions but
      // socket.ts would never read it, so the recap would re-show on next visit.
      sessionStorage.setItem('ai-village-last-seen-day', String(time.day));
    } catch {
      // sessionStorage may be unavailable in private browsing mode
    }
  };

  // Highlight agent names in text
  const highlightNames = (text: string) => {
    const agentNames = agents.map(a => a.config.name);
    const parts: React.ReactNode[] = [];
    let remaining = text;
    let key = 0;

    while (remaining.length > 0) {
      let earliestIdx = remaining.length;
      let matchedName = '';

      for (const name of agentNames) {
        const idx = remaining.indexOf(name);
        if (idx >= 0 && idx < earliestIdx) {
          earliestIdx = idx;
          matchedName = name;
        }
      }

      if (matchedName && earliestIdx < remaining.length) {
        if (earliestIdx > 0) {
          parts.push(<span key={key++}>{remaining.substring(0, earliestIdx)}</span>);
        }
        const color = hexToString(nameToColor(matchedName));
        parts.push(
          <span key={key++} style={{ color, fontWeight: 'bold' }}>
            {matchedName}
          </span>
        );
        remaining = remaining.substring(earliestIdx + matchedName.length);
      } else {
        parts.push(<span key={key++}>{remaining}</span>);
        break;
      }
    }

    return parts;
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100,
        background: 'rgba(0, 0, 0, 0.92)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        animation: 'fadeIn 1s ease-out',
      }}
    >
      <div
        style={{
          maxWidth: 650,
          width: '90%',
          maxHeight: '85vh',
          overflowY: 'auto',
          padding: '40px',
        }}
      >
        {/* Title */}
        <div
          style={{
            fontFamily: FONTS.pixel,
            fontSize: '16px',
            color: '#ffd700',
            textAlign: 'center',
            letterSpacing: 4,
            marginBottom: 12,
            animation: 'fadeIn 1.5s ease-out',
          }}
        >
          PREVIOUSLY ON
        </div>
        <div
          style={{
            fontFamily: FONTS.pixel,
            fontSize: '24px',
            color: '#64ffda',
            textAlign: 'center',
            letterSpacing: 6,
            marginBottom: 40,
            animation: 'fadeIn 2s ease-out',
          }}
        >
          AI VILLAGE
        </div>

        {/* Days covered */}
        <div
          style={{
            fontFamily: FONTS.body,
            fontSize: '14px',
            color: '#666',
            textAlign: 'center',
            marginBottom: 30,
          }}
        >
          Days {recap.fromDay} &ndash; {recap.toDay}
        </div>

        {/* Segments */}
        {recap.segments.map((segment, i) => (
          <div
            key={i}
            style={{
              marginBottom: 24,
              paddingLeft: 20,
              borderLeft: '2px solid #ffd70060',
              animation: `fadeIn ${1 + i * 0.3}s ease-out`,
            }}
          >
            <div
              style={{
                fontFamily: FONTS.pixel,
                fontSize: '10px',
                color: '#ffd700',
                marginBottom: 6,
                letterSpacing: 1,
              }}
            >
              {segment.title}
            </div>
            <div
              style={{
                fontFamily: FONTS.body,
                fontSize: '14px',
                color: '#d0d0e0',
                lineHeight: 1.7,
              }}
            >
              {highlightNames(segment.description)}
            </div>
          </div>
        ))}

        {/* Dramatic narrative */}
        {recap.narrative && (
          <div
            style={{
              marginTop: 30,
              padding: '20px',
              background: 'rgba(255, 215, 0, 0.05)',
              borderRadius: 8,
              fontFamily: FONTS.body,
              fontSize: '15px',
              color: '#e0e0e0',
              lineHeight: 1.8,
              fontStyle: 'italic',
              textAlign: 'center',
            }}
          >
            {highlightNames(recap.narrative)}
          </div>
        )}

        {/* Dismiss button */}
        <div style={{ textAlign: 'center', marginTop: 40 }}>
          <button
            onClick={dismiss}
            style={{
              fontFamily: FONTS.pixel,
              fontSize: '11px',
              color: '#0f0f23',
              background: '#64ffda',
              border: 'none',
              padding: '12px 32px',
              borderRadius: 4,
              cursor: 'pointer',
              letterSpacing: 2,
            }}
          >
            CONTINUE WATCHING
          </button>
        </div>
      </div>

      <style>{`
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(10px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
};
