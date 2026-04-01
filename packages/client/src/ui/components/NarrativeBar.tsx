import React, { useState, useEffect, useRef } from 'react';
import { useNarratives, useAgents } from '../../core/hooks';
import { nameToColor, hexToString } from '../../utils/color';
import { FONTS } from '../styles';

interface NarrativeBarProps {
  sidebarWidth?: number;
  inline?: boolean;
}

export const NarrativeBar: React.FC<NarrativeBarProps> = ({ sidebarWidth = 500, inline = false }) => {
  const narratives = useNarratives();
  const agents = useAgents();
  const [displayedText, setDisplayedText] = useState('');
  const [currentNarrativeId, setCurrentNarrativeId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const typewriterRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const latestNarrative = narratives[narratives.length - 1];

  // Typewriter effect
  useEffect(() => {
    if (!latestNarrative || latestNarrative.id === currentNarrativeId) return;

    setCurrentNarrativeId(latestNarrative.id);
    setDisplayedText('');

    if (typewriterRef.current) clearInterval(typewriterRef.current);

    let charIndex = 0;
    const text = latestNarrative.content;
    typewriterRef.current = setInterval(() => {
      charIndex++;
      setDisplayedText(text.substring(0, charIndex));
      if (charIndex >= text.length) {
        if (typewriterRef.current) clearInterval(typewriterRef.current);
      }
    }, 30);

    return () => {
      if (typewriterRef.current) clearInterval(typewriterRef.current);
    };
  }, [latestNarrative?.id]);

  if (narratives.length === 0) return null;

  // Highlight agent names in narrative text
  const renderHighlightedText = (text: string) => {
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
      style={inline ? {
        width: '100%',
        zIndex: 15,
        pointerEvents: 'auto',
      } : {
        position: 'absolute',
        bottom: 0,
        left: 0,
        width: `calc(100% - ${sidebarWidth}px)`,
        transition: 'width 0.25s ease',
        zIndex: 15,
        pointerEvents: 'auto',
      }}
    >
      {/* Expanded history */}
      {expanded && (
        <div
          style={{
            maxHeight: 300,
            overflowY: 'auto',
            background: 'rgba(15, 15, 35, 0.92)',
            borderTop: '1px solid rgba(255, 215, 0, 0.3)',
            padding: '12px 20px',
          }}
        >
          {narratives.slice(0, -1).reverse().map(n => (
            <div
              key={n.id}
              style={{
                padding: '8px 0',
                borderBottom: '1px solid rgba(255,255,255,0.05)',
                fontFamily: FONTS.body,
                fontSize: '13px',
                color: '#b0b0c0',
                lineHeight: 1.5,
              }}
            >
              <span style={{ color: '#666', fontSize: '11px', marginRight: 8 }}>
                Day {n.gameDay} {n.gameHour}:00
              </span>
              {renderHighlightedText(n.content)}
            </div>
          ))}
        </div>
      )}

      {/* Main narrative bar */}
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          background: 'rgba(15, 15, 35, 0.85)',
          borderTop: '1px solid rgba(255, 215, 0, 0.3)',
          padding: '14px 20px',
          cursor: 'pointer',
          minHeight: 60,
          display: 'flex',
          alignItems: 'flex-start',
          gap: 12,
        }}
      >
        {/* Narrator label */}
        <div
          style={{
            fontFamily: FONTS.pixel,
            fontSize: '8px',
            color: '#ffd700',
            letterSpacing: 1,
            flexShrink: 0,
            paddingTop: 2,
          }}
        >
          NARRATOR
        </div>

        {/* Narrative text */}
        <div
          style={{
            fontFamily: FONTS.body,
            fontSize: '14px',
            color: '#e0e0e0',
            lineHeight: 1.6,
            fontStyle: 'italic',
            flex: 1,
          }}
        >
          {renderHighlightedText(displayedText)}
          <span style={{ opacity: 0.5, animation: 'blink 1s step-end infinite' }}>|</span>
        </div>
      </div>

      <style>{`
        @keyframes blink {
          50% { opacity: 0; }
        }
      `}</style>
    </div>
  );
};
