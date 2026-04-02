import React from 'react';
import { useWerewolfGodMode, useWerewolfPhase } from '../../core/hooks';
import { gameStore } from '../../core/GameStore';
import { COLORS, FONTS } from '../styles';

const PHASE_INFO: Record<string, { label: string; color: string }> = {
  night: { label: 'NIGHT', color: '#6366f1' },
  dawn: { label: 'DAWN', color: '#f59e0b' },
  day: { label: 'DAY', color: '#fbbf24' },
  vote: { label: 'VOTE', color: '#ef4444' },
  ended: { label: 'ENDED', color: '#6b7280' },
};

export const WerewolfControls: React.FC = () => {
  const godMode = useWerewolfGodMode();
  const { phase, round } = useWerewolfPhase();

  if (!phase) return null;

  const info = PHASE_INFO[phase] ?? { label: phase.toUpperCase(), color: COLORS.textDim };

  return (
    <div
      style={{
        position: 'absolute',
        top: 12,
        right: 12,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        zIndex: 20,
      }}
    >
      {/* Phase indicator */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '5px 10px',
          background: COLORS.bg,
          border: `1px solid ${COLORS.border}`,
          borderRadius: 4,
          fontFamily: FONTS.pixel,
          fontSize: '7px',
          letterSpacing: 1,
        }}
      >
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: info.color,
            display: 'inline-block',
            boxShadow: `0 0 6px ${info.color}`,
          }}
        />
        <span style={{ color: info.color }}>{info.label}</span>
        <span style={{ color: COLORS.textDim }}>R{round}</span>
      </div>

      {/* God mode toggle */}
      <button
        onClick={() => gameStore.toggleWerewolfGodMode()}
        style={{
          padding: '5px 10px',
          background: godMode ? '#2a1a1a' : COLORS.bg,
          border: `1px solid ${godMode ? '#ef4444' : COLORS.border}`,
          borderRadius: 4,
          cursor: 'pointer',
          color: godMode ? '#ef4444' : COLORS.textDim,
          fontFamily: FONTS.pixel,
          fontSize: '7px',
          letterSpacing: 1,
          transition: 'all 0.2s',
        }}
      >
        {godMode ? 'HIDE ROLES' : 'SHOW ROLES'}
      </button>
    </div>
  );
};
