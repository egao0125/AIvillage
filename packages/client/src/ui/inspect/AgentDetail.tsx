import React from 'react';
import { COLORS, FONTS } from '../styles';
import { useAgentsMap, useAgentEvents, useBoard } from '../../core/hooks';
import { ProfileHeader } from './ProfileHeader';
import { CharacterArc } from './CharacterArc';
import { Relationships } from './Relationships';
import { AgentStats } from './AgentStats';

const Divider: React.FC = () => (
  <div style={{ height: 1, backgroundColor: COLORS.border, opacity: 0.3, margin: '16px 0' }} />
);

export const AgentDetail: React.FC<{ agentId: string }> = ({ agentId }) => {
  const agentsMap = useAgentsMap();
  const agent = agentsMap.get(agentId);
  const events = useAgentEvents(agentId);
  const board = useBoard();

  if (!agent) {
    return <div style={{ fontFamily: FONTS.body, fontSize: 13, color: COLORS.textDim, padding: 16 }}>Agent not found</div>;
  }

  // Find board posts that this agent has commented on
  const reactions = board
    .filter((post) => post.comments?.some((c) => c.agentId === agentId))
    .slice(0, 10);

  return (
    <div>
      <ProfileHeader agent={agent} />
      <Divider />
      <CharacterArc agentId={agentId} />
      <Divider />
      <Relationships agent={agent} />
      <Divider />

      {/* Events */}
      <div style={{ padding: '8px 0' }}>
        <div style={{ fontFamily: FONTS.pixel, fontSize: 8, color: COLORS.textDim, letterSpacing: 2, marginBottom: 8 }}>
          EVENTS
        </div>
        {events.length === 0 ? (
          <div style={{ fontFamily: FONTS.body, fontSize: 12, color: COLORS.textDim }}>No events yet</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {events.slice(0, 15).map((event) => (
              <div key={event.id} style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontFamily: FONTS.body,
                fontSize: 11,
                color: COLORS.text,
                cursor: 'pointer',
              }}>
                <span>{event.icon}</span>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {event.headline.length > 80 ? event.headline.slice(0, 80) + '...' : event.headline}
                </span>
                <span style={{ color: COLORS.textDim, fontSize: 10, flexShrink: 0 }}>Day {event.day}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <Divider />

      {/* Reactions */}
      <div style={{ padding: '8px 0' }}>
        <div style={{ fontFamily: FONTS.pixel, fontSize: 8, color: COLORS.textDim, letterSpacing: 2, marginBottom: 8 }}>
          REACTIONS
        </div>
        {reactions.length === 0 ? (
          <div style={{ fontFamily: FONTS.body, fontSize: 12, color: COLORS.textDim }}>No reactions yet</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {reactions.map((post) => {
              const agentComment = post.comments?.find((c) => c.agentId === agentId);
              return (
                <div key={post.id} style={{ backgroundColor: COLORS.bgCard, borderRadius: 4, padding: 8 }}>
                  <div style={{ fontFamily: FONTS.body, fontSize: 11, color: COLORS.textDim, marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {post.content.length > 60 ? post.content.slice(0, 60) + '...' : post.content}
                  </div>
                  {agentComment && (
                    <div style={{ fontFamily: FONTS.body, fontSize: 11, color: COLORS.text, fontStyle: 'italic', paddingLeft: 8, borderLeft: `2px solid ${COLORS.accent}` }}>
                      {agentComment.content}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <Divider />
      <AgentStats agent={agent} />
    </div>
  );
};
