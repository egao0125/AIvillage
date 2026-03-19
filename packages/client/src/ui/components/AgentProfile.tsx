import React from 'react';
import type { Agent } from '@ai-village/shared';
import { nameToColor, hexToString } from '../../utils/color';
import { COLORS, FONTS } from '../styles';

interface AgentProfileProps {
  agent: Agent;
  onClose: () => void;
}

export const AgentProfile: React.FC<AgentProfileProps> = ({
  agent,
  onClose,
}) => {
  const color = hexToString(nameToColor(agent.config.name));

  return (
    <div
      style={{
        padding: 16,
        fontFamily: FONTS.pixel,
        fontSize: '7px',
        color: COLORS.text,
        borderBottom: `1px solid ${COLORS.border}`,
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          marginBottom: 12,
        }}
      >
        <div
          style={{
            width: 48,
            height: 48,
            borderRadius: '50%',
            background: color,
            border: `2px solid ${COLORS.accent}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '18px',
            flexShrink: 0,
          }}
        >
          {agent.config.name[0]}
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: '10px', marginBottom: 4 }}>
            {agent.config.name}
          </div>
          <div style={{ color: COLORS.textDim }}>
            {agent.config.occupation}, {agent.config.age}
          </div>
        </div>
        <button
          onClick={onClose}
          style={{
            background: 'none',
            border: 'none',
            color: COLORS.textDim,
            cursor: 'pointer',
            fontSize: '10px',
            fontFamily: FONTS.pixel,
          }}
        >
          {'\u2715'}
        </button>
      </div>

      {/* Currency */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: 12,
          padding: '8px 12px',
          background: COLORS.bgCard,
          borderRadius: 4,
          border: `1px solid ${COLORS.border}`,
        }}
      >
        <span style={{ fontSize: '14px' }}>{'🪙'}</span>
        <div>
          <div style={{ color: COLORS.gold, fontSize: '10px', fontWeight: 'bold' }}>
            {agent.currency ?? 0} Gold
          </div>
          <div style={{ color: COLORS.textDim, fontSize: '6px', marginTop: 2 }}>
            Village Currency
          </div>
        </div>
      </div>

      {/* Soul */}
      {agent.config.soul && (
        <div style={{ marginBottom: 12 }}>
          <div
            style={{
              color: COLORS.textAccent,
              marginBottom: 4,
              fontSize: '6px',
            }}
          >
            SOUL
          </div>
          <div style={{ color: COLORS.textDim, lineHeight: '1.6' }}>
            {agent.config.soul}
          </div>
        </div>
      )}

      {/* Current state */}
      <div>
        <div
          style={{
            color: COLORS.textAccent,
            marginBottom: 4,
            fontSize: '6px',
          }}
        >
          STATUS
        </div>
        <div style={{ color: COLORS.textDim }}>
          {agent.currentAction || agent.state}
        </div>
        <div style={{ color: COLORS.textDim, marginTop: 2 }}>
          ({agent.position.x}, {agent.position.y})
        </div>
      </div>
    </div>
  );
};
