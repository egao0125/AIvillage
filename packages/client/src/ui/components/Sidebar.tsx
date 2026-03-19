import React, { useState } from 'react';
import { useAgents, useSelectedAgent, useBoard } from '../../core/hooks';
import { selectAgent } from '../../network/socket';
import { AgentCard } from './AgentCard';
import { AgentProfile } from './AgentProfile';
import { ChatLog } from './ChatLog';
import { VillageBoard } from './VillageBoard';
import { COLORS, FONTS, SIZES } from '../styles';

type Tab = 'villagers' | 'chat' | 'board';

export const Sidebar: React.FC = () => {
  const [activeTab, setActiveTab] = useState<Tab>('villagers');
  const agents = useAgents();
  const selectedAgent = useSelectedAgent();
  const board = useBoard();

  return (
    <div
      style={{
        width: SIZES.sidebarWidth,
        height: '100vh',
        background: COLORS.bg,
        borderLeft: `1px solid ${COLORS.border}`,
        display: 'flex',
        flexDirection: 'column',
        flexShrink: 0,
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '12px 16px',
          borderBottom: `1px solid ${COLORS.border}`,
          fontFamily: FONTS.pixel,
          fontSize: '10px',
          color: COLORS.textAccent,
          letterSpacing: 1,
        }}
      >
        AI VILLAGE
      </div>

      {/* Tabs */}
      <div
        style={{
          display: 'flex',
          borderBottom: `1px solid ${COLORS.border}`,
        }}
      >
        {(['villagers', 'chat', 'board'] as Tab[]).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            style={{
              flex: 1,
              padding: '8px 0',
              border: 'none',
              cursor: 'pointer',
              background: activeTab === tab ? COLORS.bgCard : 'transparent',
              color: activeTab === tab ? COLORS.textAccent : COLORS.textDim,
              fontFamily: FONTS.pixel,
              fontSize: '7px',
              borderBottom:
                activeTab === tab
                  ? `2px solid ${COLORS.accent}`
                  : '2px solid transparent',
              textTransform: 'uppercase',
            }}
          >
            {tab === 'villagers'
              ? `Villagers (${agents.length})`
              : tab === 'board'
              ? `Board${board.length > 0 ? ` (${board.length})` : ''}`
              : 'Chat'}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {activeTab === 'villagers' ? (
          <>
            {selectedAgent && (
              <AgentProfile
                agent={selectedAgent}
                onClose={() => selectAgent('')}
              />
            )}
            {agents.map((agent) => (
              <AgentCard
                key={agent.id}
                agent={agent}
                selected={selectedAgent?.id === agent.id}
                onClick={() => selectAgent(agent.id)}
              />
            ))}
          </>
        ) : activeTab === 'board' ? (
          <VillageBoard />
        ) : (
          <ChatLog />
        )}
      </div>
    </div>
  );
};
