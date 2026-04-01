import React, { useMemo } from 'react';
import { COLORS, FONTS } from '../styles';
import { useVillageMemory } from '../../core/hooks';

const TYPE_COLORS: Record<string, string> = {
  death: '#6b7280',
  rule: '#fbbf24',
  betrayal: '#ef4444',
  alliance: '#4ade80',
  crisis: '#ef4444',
  broken_oath: '#ff6b6b',
};

const badgeStyle = (type: string): React.CSSProperties => ({
  fontFamily: FONTS.pixel,
  fontSize: 6,
  color: '#000',
  background: TYPE_COLORS[type] ?? COLORS.textDim,
  padding: '2px 6px',
  borderRadius: 8,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  flexShrink: 0,
});

const SignificanceBar: React.FC<{ value: number }> = ({ value }) => (
  <div style={{ display: 'flex', gap: 2, alignItems: 'center' }}>
    {Array.from({ length: 10 }, (_, i) => (
      <div
        key={i}
        style={{
          width: 4,
          height: 4,
          borderRadius: '50%',
          background: i < value ? COLORS.accent : COLORS.border,
        }}
      />
    ))}
  </div>
);

export const VillageHistory: React.FC = () => {
  const memory = useVillageMemory();

  const sorted = useMemo(
    () => [...memory].sort((a, b) => b.significance - a.significance).slice(0, 10),
    [memory]
  );

  return (
    <div>
      <div
        style={{
          fontFamily: FONTS.pixel,
          fontSize: 8,
          color: COLORS.textDim,
          marginBottom: 10,
          letterSpacing: 1,
        }}
      >
        VILLAGE HISTORY
      </div>

      {sorted.length === 0 ? (
        <div style={{ fontFamily: FONTS.body, fontSize: 11, color: COLORS.textDim }}>
          No significant events recorded yet.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {sorted.map((entry, i) => (
            <div
              key={i}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
                background: COLORS.bgCard,
                border: `1px solid ${COLORS.border}`,
                borderRadius: 4,
                padding: 8,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={badgeStyle(entry.type)}>{entry.type.replace('_', ' ')}</span>
                <span
                  style={{
                    fontFamily: FONTS.pixel,
                    fontSize: 6,
                    color: COLORS.textDim,
                    marginLeft: 'auto',
                  }}
                >
                  Day {entry.day}
                </span>
              </div>
              <div style={{ fontFamily: FONTS.body, fontSize: 11, color: COLORS.text, lineHeight: 1.4 }}>
                {entry.content}
              </div>
              <SignificanceBar value={entry.significance} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
