import React from 'react';
import { useWerewolfGodMode, useWerewolfPhase, useAgents } from '../../core/hooks';
import { gameStore } from '../../core/GameStore';
import { werewolfStart } from '../../network/socket';
import { COLORS, FONTS } from '../styles';

const PHASE_INFO: Record<string, { label: string; color: string }> = {
  night: { label: 'NIGHT', color: '#6366f1' },
  dawn: { label: 'DAWN', color: '#f59e0b' },
  day: { label: 'DAY', color: '#fbbf24' },
  vote: { label: 'VOTE', color: '#ef4444' },
  ended: { label: 'ENDED', color: '#6b7280' },
};

const btnStyle: React.CSSProperties = {
  padding: '5px 10px',
  background: COLORS.bg,
  border: `1px solid ${COLORS.border}`,
  borderRadius: 4,
  cursor: 'pointer',
  fontFamily: FONTS.pixel,
  fontSize: '7px',
  letterSpacing: 1,
  transition: 'all 0.2s',
};

export const WerewolfControls: React.FC = () => {
  const godMode = useWerewolfGodMode();
  const { phase, round } = useWerewolfPhase();
  const agents = useAgents();

  const containerStyle: React.CSSProperties = {
    position: 'absolute',
    top: 12,
    right: 392,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    zIndex: 110,
  };

  // Before game starts — show START button
  if (!phase) {
    const agentCount = agents.filter(a => a.alive !== false).length;
    const canStart = agentCount >= 6;

    return (
      <div style={containerStyle}>
        <span style={{ fontFamily: FONTS.pixel, fontSize: '7px', color: COLORS.textDim, letterSpacing: 1 }}>
          {agentCount} AGENTS
        </span>
        <button
          onClick={() => canStart && werewolfStart()}
          style={{
            ...btnStyle,
            color: canStart ? '#4ade80' : COLORS.textDim,
            border: `1px solid ${canStart ? '#4ade80' : COLORS.border}`,
            cursor: canStart ? 'pointer' : 'not-allowed',
            opacity: canStart ? 1 : 0.5,
          }}
        >
          START GAME
        </button>
      </div>
    );
  }

  const info = PHASE_INFO[phase] ?? { label: phase.toUpperCase(), color: COLORS.textDim };

  return (
    <div style={containerStyle}>
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
          ...btnStyle,
          background: godMode ? '#2a1a1a' : COLORS.bg,
          color: godMode ? '#ef4444' : COLORS.textDim,
          border: `1px solid ${godMode ? '#ef4444' : COLORS.border}`,
        }}
      >
        {godMode ? 'HIDE ROLES' : 'SHOW ROLES'}
      </button>
    </div>
  );
};
