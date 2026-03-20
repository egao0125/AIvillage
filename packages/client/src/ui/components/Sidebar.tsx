import React, { useState } from 'react';
import { useAgents, useSelectedAgent, useBoard, useWorldEvents, useArtifacts } from '../../core/hooks';
import { selectAgent } from '../../network/socket';
import { AgentCard } from './AgentCard';
import { AgentProfile } from './AgentProfile';
import { ChatLog } from './ChatLog';
import { ArtifactGallery } from './ArtifactGallery';
import { VillageBoard } from './VillageBoard';
import { WorldEvents } from './WorldEvents';
import { COLORS, FONTS, SIZES } from '../styles';

type Tab = 'villagers' | 'chat' | 'board' | 'artifacts' | 'events';

export const Sidebar: React.FC = () => {
  const [activeTab, setActiveTab] = useState<Tab>('villagers');
  const agents = useAgents();
  const selectedAgent = useSelectedAgent();
  const board = useBoard();
  const events = useWorldEvents();
  const artifacts = useArtifacts();

  const tabLabel = (tab: Tab): string => {
    switch (tab) {
      case 'villagers':
        return `Villagers (${agents.length})`;
      case 'chat':
        return 'Chat';
      case 'board':
        return `Board${board.length > 0 ? ` (${board.length})` : ''}`;
      case 'artifacts':
        return `Media${artifacts.length > 0 ? ` (${artifacts.length})` : ''}`;
      case 'events':
        return `Events${events.filter((e) => e.active).length > 0 ? ` (${events.filter((e) => e.active).length})` : ''}`;
    }
  };

  return (
    <div
      style={{
        width: 420,
        height: '100%',
        background: COLORS.bg,
        borderLeft: `1px solid ${COLORS.border}`,
        display: 'flex',
        flexDirection: 'column',
        flexShrink: 0,
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '14px 18px',
          borderBottom: `1px solid ${COLORS.border}`,
          fontFamily: FONTS.pixel,
          fontSize: '14px',
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
        {(['villagers', 'chat', 'board', 'artifacts', 'events'] as Tab[]).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            style={{
              flex: 1,
              padding: '10px 4px',
              border: 'none',
              cursor: 'pointer',
              background: activeTab === tab ? COLORS.bgCard : 'transparent',
              color: activeTab === tab ? COLORS.textAccent : COLORS.textDim,
              fontFamily: FONTS.pixel,
              fontSize: '9px',
              borderBottom:
                activeTab === tab
                  ? `2px solid ${COLORS.accent}`
                  : '2px solid transparent',
              textTransform: 'uppercase',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {tabLabel(tab)}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
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
        ) : activeTab === 'artifacts' ? (
          <ArtifactGallery />
        ) : activeTab === 'events' ? (
          <WorldEvents />
        ) : (
          <ChatLog />
        )}
      </div>
    </div>
  );
};
