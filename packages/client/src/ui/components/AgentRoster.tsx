import React, { useState } from 'react';
import { useAgents, useSelectedAgent } from '../../core/hooks';
import { gameStore } from '../../core/GameStore';
import { selectAgent } from '../../network/socket';
import { AgentCard } from './AgentCard';
import { FONTS } from '../styles';
import { useTheme } from '../ThemeContext';

interface AgentRosterProps {
  onAddAgent?: () => void;
}

export const AgentRoster: React.FC<AgentRosterProps> = ({ onAddAgent }) => {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const agents = useAgents();
  const selectedAgent = useSelectedAgent();
  const aliveAgents = agents.filter(a => a.alive !== false);

  return (
    <div style={{ position: 'absolute', top: 48, left: 8, zIndex: 20, pointerEvents: 'auto', background: colors.bg, borderRadius: 6 }}>
      {/* Toggle pill */}
      <button
        onClick={() => setOpen(prev => !prev)}
        style={{
          padding: '5px 12px',
          fontFamily: FONTS.pixel,
          fontSize: '8px',
          color: open ? colors.accent : colors.textDim,
          background: colors.bg,
          border: `1px solid ${open ? colors.accent : colors.border}`,
          borderRadius: 4,
          cursor: 'pointer',
          letterSpacing: 0.5,
        }}
      >
        AGENTS ({aliveAgents.length})
      </button>

      {/* Roster panel */}
      {open && (
        <div
          style={{
            marginTop: 4,
            width: 280,
            maxHeight: 400,
            overflowY: 'auto',
            overscrollBehavior: 'contain',
            background: colors.bg,
            border: `1px solid ${colors.border}`,
            borderRadius: 6,
            boxShadow: '0 4px 24px rgba(0,0,0,0.5)',
          }}
        >
          {/* Add agent button at top */}
          {onAddAgent && (
            <button
              onClick={() => { onAddAgent(); setOpen(false); }}
              style={{
                width: '100%',
                padding: '12px 16px',
                background: 'transparent',
                border: 'none',
                borderBottom: `1px solid ${colors.border}`,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                fontFamily: FONTS.pixel,
                fontSize: '8px',
                color: colors.accent,
                letterSpacing: 1,
                transition: 'background 0.15s',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = colors.bgHover; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
            >
              + ADD AGENT
            </button>
          )}
          {aliveAgents.map(agent => (
            <AgentCard
              key={agent.id}
              agent={agent}
              selected={selectedAgent?.id === agent.id}
              onClick={() => {
                selectAgent(agent.id);
                gameStore.openAgentDetail(agent.id);
                setOpen(false);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
};
