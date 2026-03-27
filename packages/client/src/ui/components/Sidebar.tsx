import React, { useState } from 'react';
import { useAgents, useSelectedAgent, useBoard } from '../../core/hooks';
import { selectAgent } from '../../network/socket';
import { AgentCard } from './AgentCard';
import { AgentProfile } from './AgentProfile';
import { VillageDashboard } from './VillageDashboard';
import { ConfessionalPanel } from './ConfessionalPanel';
import { StorylinePanel } from './StorylinePanel';
import { gameStore } from '../../core/GameStore';
import { COLORS, FONTS } from '../styles';

export const SIDEBAR_WIDTH = 500;

type Tab = 'villagers' | 'village' | 'confessional' | 'recap';

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({ collapsed }) => {
  const [activeTab, setActiveTab] = useState<Tab>('villagers');
  const agents = useAgents();
  const selectedAgent = useSelectedAgent();
  const board = useBoard();

  // Count village items: rules + decrees + alliances + announcements
  const villageCount = board.filter(p =>
    (p.type === 'decree' || p.type === 'rule' || p.type === 'announcement' || p.type === 'alliance') && !p.revoked
  ).length;

  const tabLabel = (tab: Tab): string => {
    switch (tab) {
      case 'villagers':
        return `Villagers (${agents.length})`;
      case 'village':
        return `Village${villageCount > 0 ? ` (${villageCount})` : ''}`;
      case 'confessional':
        return 'Thoughts';
      case 'recap':
        return 'Recap';
    }
  };

  return (
    <div
      style={{
        width: collapsed ? 0 : SIDEBAR_WIDTH,
        height: '100%',
        background: COLORS.bg,
        borderLeft: collapsed ? 'none' : `1px solid ${COLORS.border}`,
        display: 'flex',
        flexDirection: 'column',
        flexShrink: 0,
        overflow: 'hidden',
        transition: 'width 0.25s ease',
        position: 'relative',
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
          whiteSpace: 'nowrap',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        AI VILLAGE
        <button
          onClick={() => gameStore.openSocialView()}
          title="Social Dynamics"
          style={{
            background: 'none',
            border: `1px solid ${COLORS.border}`,
            borderRadius: 4,
            cursor: 'pointer',
            padding: '4px 8px',
            color: COLORS.textDim,
            fontFamily: FONTS.body,
            fontSize: 14,
            lineHeight: 1,
            transition: 'color 0.2s, border-color 0.2s',
          }}
          onMouseEnter={e => {
            e.currentTarget.style.color = COLORS.textAccent;
            e.currentTarget.style.borderColor = COLORS.accent;
          }}
          onMouseLeave={e => {
            e.currentTarget.style.color = COLORS.textDim;
            e.currentTarget.style.borderColor = COLORS.border;
          }}
        >
          &#x1F578;
        </button>
      </div>

      {/* Tabs */}
      <div
        style={{
          display: 'flex',
          borderBottom: `1px solid ${COLORS.border}`,
        }}
      >
        {(['villagers', 'village', 'confessional', 'recap'] as Tab[]).map((tab) => (
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
            {agents.filter(a => a.alive !== false).map((agent) => (
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
        ) : activeTab === 'confessional' ? (
          <ConfessionalPanel />
        ) : activeTab === 'recap' ? (
          <StorylinePanel />
        ) : null}
      </div>
    </div>
  );
};
