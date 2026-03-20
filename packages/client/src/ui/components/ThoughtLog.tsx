import React, { useRef, useEffect } from 'react';
import { useThoughts } from '../../core/hooks';
import { nameToColor, hexToString } from '../../utils/color';
import { COLORS, FONTS } from '../styles';

export const ThoughtLog: React.FC = () => {
  const thoughts = useThoughts();
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [thoughts.length]);

  if (thoughts.length === 0) {
    return (
      <div style={{ padding: 20, textAlign: 'center', color: COLORS.textDim, fontFamily: FONTS.body, fontSize: '13px' }}>
        No thoughts yet. Agents think before acting...
      </div>
    );
  }

  return (
    <div style={{ padding: '8px 0' }}>
      {thoughts.map(t => {
        const color = hexToString(nameToColor(t.agentName));
        return (
          <div key={t.id} style={{
            padding: '8px 16px',
            borderBottom: `1px solid ${COLORS.border}`,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <div style={{
                width: 6, height: 6, borderRadius: '50%', background: color, flexShrink: 0,
              }} />
              <span style={{ fontFamily: FONTS.pixel, fontSize: '9px', color }}>
                {t.agentName}
              </span>
              <span style={{ fontFamily: FONTS.body, fontSize: '10px', color: COLORS.textDim, marginLeft: 'auto' }}>
                {new Date(t.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
            <div style={{
              fontFamily: FONTS.body,
              fontSize: '12px',
              color: COLORS.textDim,
              fontStyle: 'italic',
              lineHeight: '1.5',
              paddingLeft: 12,
              borderLeft: `2px solid ${color}33`,
            }}>
              {t.thought}
            </div>
          </div>
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
};
