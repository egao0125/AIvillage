import React, { useState } from 'react';
import { useAgents, useSelectedAgent } from '../../core/hooks';
import { gameStore } from '../../core/GameStore';
import { selectAgent } from '../../network/socket';
import { AgentCard } from './AgentCard';
import { COLORS, FONTS } from '../styles';

export const AgentRoster: React.FC = () => {
  const [open, setOpen] = useState(false);
  const agents = useAgents();
  const selectedAgent = useSelectedAgent();
  const aliveAgents = agents.filter(a => a.alive !== false);

  return (
    <div style={{ position: 'absolute', top: 48, left: 8, zIndex: 20, pointerEvents: 'auto' }}>
      {/* Toggle pill */}
      <button
        onClick={() => setOpen(prev => !prev)}
        style={{
          padding: '5px 12px',
          fontFamily: FONTS.pixel,
          fontSize: '8px',
          color: open ? COLORS.accent : COLORS.textDim,
          background: COLORS.bg,
          border: `1px solid ${open ? COLORS.accent : COLORS.border}`,
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
            background: COLORS.bg,
            border: `1px solid ${COLORS.border}`,
            borderRadius: 6,
            boxShadow: '0 4px 24px rgba(0,0,0,0.5)',
          }}
        >
          {aliveAgents.map(agent => (
            <AgentCard
              key={agent.id}
              agent={agent}
              selected={selectedAgent?.id === agent.id}
              onClick={() => {
                selectAgent(agent.id);
                gameStore.inspectAgent(agent.id);
                setOpen(false);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
};
