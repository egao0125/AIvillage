import React from 'react';
import type { Agent } from '@ai-village/shared';
import { nameToColor, hexToString } from '../../utils/color';
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
  };

  return (
    <div
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '10px 12px',
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
          width: 32,
          height: 32,
          borderRadius: '50%',
          background: color,
          border: '2px solid rgba(255,255,255,0.2)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '12px',
          flexShrink: 0,
        }}
      >
        {agent.config.name[0]}
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontFamily: FONTS.pixel,
            fontSize: '8px',
            color: COLORS.text,
            marginBottom: 3,
          }}
        >
          {agent.config.name}
        </div>
        <div
          style={{
            fontFamily: FONTS.pixel,
            fontSize: '6px',
            color: COLORS.textDim,
          }}
        >
          {agent.config.occupation}
        </div>
        <div
          style={{
            fontFamily: FONTS.pixel,
            fontSize: '6px',
            color: COLORS.textDim,
            marginTop: 2,
          }}
        >
          {agent.currentAction || agent.state}
        </div>
      </div>

      {/* Currency + state */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, flexShrink: 0 }}>
        <div
          style={{
            fontFamily: FONTS.pixel,
            fontSize: '7px',
            color: COLORS.gold,
          }}
        >
          {agent.currency ?? 0} G
        </div>
        <div
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: stateColors[agent.state] || COLORS.idle,
          }}
        />
      </div>
    </div>
  );
};
