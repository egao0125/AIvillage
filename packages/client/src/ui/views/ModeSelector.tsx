import React from 'react';
import { COLORS, FONTS } from '../styles';
import { gameStore } from '../../core/GameStore';
import { useActiveMode } from '../../core/hooks';

type Mode = 'watch' | 'analyze';

const MODES: { key: Mode; icon: string; label: string }[] = [
  { key: 'watch', icon: '👁', label: 'Watch' },
  { key: 'analyze', icon: '📊', label: 'Analyze' },
];

export const ModeSelector: React.FC = () => {
  const activeMode = useActiveMode();

  return (
    <div style={{ display: 'flex', gap: 2 }}>
      {MODES.map(({ key, icon, label }) => {
        const isActive = activeMode === key;
        return (
          <button
            key={key}
            onClick={() => gameStore.setMode(key)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              padding: '4px 10px',
              background: isActive ? COLORS.bgHover : 'transparent',
              border: `1px solid ${isActive ? COLORS.accent : COLORS.border}`,
              borderRadius: 4,
              cursor: 'pointer',
              color: isActive ? COLORS.accent : COLORS.textDim,
              fontFamily: FONTS.pixel,
              fontSize: '7px',
              letterSpacing: 1,
              transition: 'all 0.15s ease',
            }}
          >
            <span>{icon}</span>
            <span>{label}</span>
          </button>
        );
      })}
    </div>
  );
};
