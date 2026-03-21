import React from 'react';
import type { Agent } from '@ai-village/shared';
import { nameToColor, hexToString } from '../../utils/color';
import { gameStore } from '../../core/GameStore';
import { COLORS, FONTS } from '../styles';

interface AgentCardProps {
  agent: Agent;
  selected: boolean;
  onClick: () => void;
}

export const AgentCard: React.FC<AgentCardProps> = ({
  agent,
  selected,
  onClick,
}) => {
  const color = hexToString(nameToColor(agent.config.name));

  const stateColors: Record<string, string> = {
    active: COLORS.active,
    routine: COLORS.routine,
    idle: COLORS.idle,
    sleeping: COLORS.sleeping,
    dead: '#4a0000',
    away: '#6b7280',
  };

  const isDead = agent.alive === false;
  const isAway = agent.state === 'away';

  return (
    <div
      onClick={onClick}
      onDoubleClick={() => gameStore.openCharacterPage(agent.id)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '14px 16px',
        cursor: 'pointer',
        background: selected ? COLORS.bgHover : 'transparent',
        borderLeft: selected
          ? `3px solid ${COLORS.accent}`
          : '3px solid transparent',
        borderBottom: `1px solid ${COLORS.border}`,
        transition: 'background 0.15s',
      }}
      onMouseEnter={(e) => {
        if (!selected)
          (e.currentTarget as HTMLDivElement).style.background = COLORS.bgHover;
      }}
      onMouseLeave={(e) => {
        if (!selected)
          (e.currentTarget as HTMLDivElement).style.background = 'transparent';
      }}
    >
      {/* Agent avatar circle */}
      <div
        style={{
          width: 40,
          height: 40,
          borderRadius: '50%',
          background: isDead ? '#333' : isAway ? '#555' : color,
          border: '2px solid rgba(255,255,255,0.2)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '16px',
          fontWeight: 'bold',
          flexShrink: 0,
          opacity: isDead || isAway ? 0.5 : 1,
        }}
      >
        {agent.config.name[0]}
      </div>

      <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
        <div
          style={{
            fontFamily: FONTS.pixel,
            fontSize: '11px',
            color: COLORS.text,
            marginBottom: 4,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {isDead ? '\u{1F480} ' : isAway ? '\u{1F4A4} ' : ''}{agent.config.name}
        </div>
        <div
          style={{
            fontFamily: FONTS.body,
            fontSize: '13px',
            color: COLORS.textDim,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {agent.currentAction || agent.state}
        </div>
      </div>

      {/* State indicator */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6, flexShrink: 0 }}>
        <div
          style={{
            width: 10,
            height: 10,
            borderRadius: '50%',
            background: stateColors[agent.state] || COLORS.idle,
          }}
        />
      </div>
    </div>
  );
};
