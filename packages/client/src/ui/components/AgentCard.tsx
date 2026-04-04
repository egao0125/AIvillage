import React from 'react';
import type { Agent } from '@ai-village/shared';
import { nameToColor, hexToString } from '../../utils/color';
import { useReputation } from '../../core/hooks';
import { FONTS } from '../styles';
import { useTheme } from '../ThemeContext';

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
  const { colors } = useTheme();
  const color = hexToString(nameToColor(agent.config.name));
  const reputation = useReputation();
  const systemRep = reputation.find(r => r.toAgentId === agent.id && r.fromAgentId === 'system');
  const repScore = systemRep?.score ?? 0;

  const stateColors: Record<string, string> = {
    active: colors.active,
    routine: colors.routine,
    idle: colors.idle,
    sleeping: colors.sleeping,
    dead: '#4a0000',
    away: '#6b7280',
  };

  const isDead = agent.alive === false;
  const isAway = agent.state === 'away';

  return (
    <div
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 12px',
        cursor: 'pointer',
        background: selected ? colors.bgHover : 'transparent',
        borderLeft: selected
          ? `3px solid ${colors.accent}`
          : '3px solid transparent',
        borderBottom: `1px solid ${colors.border}`,
        transition: 'background 0.15s',
      }}
      onMouseEnter={(e) => {
        if (!selected)
          (e.currentTarget as HTMLDivElement).style.background = colors.bgHover;
      }}
      onMouseLeave={(e) => {
        if (!selected)
          (e.currentTarget as HTMLDivElement).style.background = 'transparent';
      }}
    >
      {/* Agent avatar circle */}
      <div
        style={{
          width: 28,
          height: 28,
          borderRadius: '50%',
          background: isDead ? '#333' : isAway ? '#555' : color,
          border: '1px solid rgba(255,255,255,0.2)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '11px',
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
            fontSize: '8px',
            color: colors.text,
            marginBottom: 2,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {isDead ? '\u{1F480} ' : isAway ? '\u{1F4A4} ' : ''}{agent.config.name}
          {repScore !== 0 && (
            <span style={{
              marginLeft: 6,
              fontSize: '7px',
              fontFamily: FONTS.pixel,
              color: repScore > 0 ? colors.active : colors.warning,
            }}>
              {repScore > 0 ? '+' : ''}{repScore}
            </span>
          )}
        </div>
        <div
          style={{
            fontFamily: FONTS.body,
            fontSize: '11px',
            color: colors.textDim,
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
            background: stateColors[agent.state] || colors.idle,
          }}
        />
      </div>
    </div>
  );
};
