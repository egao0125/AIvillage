import React, { useState } from 'react';
import { useAgents, useSelectedAgent, useBoard, useArtifacts } from '../../core/hooks';
import { selectAgent } from '../../network/socket';
import { AgentCard } from './AgentCard';
import { AgentProfile } from './AgentProfile';
import { ChatLog } from './ChatLog';
import { VillageDashboard } from './VillageDashboard';
import { GossipFeed } from './GossipFeed';
import { COLORS, FONTS } from '../styles';

type Tab = 'villagers' | 'feed' | 'village' | 'gossip';

export const Sidebar: React.FC = () => {
  const [activeTab, setActiveTab] = useState<Tab>('villagers');
  const agents = useAgents();
  const selectedAgent = useSelectedAgent();
  const board = useBoard();
  const artifacts = useArtifacts();

  // Count gossip items: rumors + threats + bounties + public artifacts
  const gossipBoardCount = board.filter(p =>
    (p.type === 'rumor' || p.type === 'threat' || p.type === 'bounty') && !p.revoked
  ).length;
  const publicArtifactCount = artifacts.filter(a => a.visibility === 'public').length;
  const gossipCount = gossipBoardCount + publicArtifactCount;

  // Count village items: rules + decrees + alliances + announcements
  const villageCount = board.filter(p =>
    (p.type === 'decree' || p.type === 'rule' || p.type === 'announcement' || p.type === 'alliance') && !p.revoked
  ).length;

  const tabLabel = (tab: Tab): string => {
    switch (tab) {
      case 'villagers':
        return `Villagers (${agents.length})`;
      case 'feed':
        return 'Feed';
      case 'village':
        return `Village${villageCount > 0 ? ` (${villageCount})` : ''}`;
      case 'gossip':
        return `Social${gossipCount > 0 ? ` (${gossipCount})` : ''}`;
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
        {(['villagers', 'feed', 'village', 'gossip'] as Tab[]).map((tab) => (
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
        ) : activeTab === 'village' ? (
          <VillageDashboard />
        ) : activeTab === 'gossip' ? (
          <GossipFeed />
        ) : (
          <ChatLog />
        )}
      </div>
    </div>
  );
};
