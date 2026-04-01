import React from 'react';
import { COLORS, FONTS } from '../styles';
import { useAgentsMap, useAgentEvents, useBoard, useInstitutions } from '../../core/hooks';
import { gameStore } from '../../core/GameStore';
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
  const institutions = useInstitutions();

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
      <AgentStats agent={agent} />
      <Divider />
      <Relationships agent={agent} />
      <Divider />

      {/* Institutions */}
      {(() => {
        const agentInstitutions = institutions.filter(
          i => !i.dissolved && i.members.some(m => m.agentId === agentId)
        );
        if (agentInstitutions.length === 0) return null;
        return (
          <div style={{ padding: '8px 0' }}>
            <div style={{ fontFamily: FONTS.pixel, fontSize: 8, color: COLORS.textDim, letterSpacing: 2, marginBottom: 8 }}>
              INSTITUTIONS
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {agentInstitutions.map(inst => {
                const member = inst.members.find(m => m.agentId === agentId);
                return (
                  <div
                    key={inst.id}
                    onClick={() => gameStore.inspectInstitution(inst.id)}
                    style={{
                      backgroundColor: COLORS.bgCard,
                      borderRadius: 4,
                      padding: '8px 10px',
                      cursor: 'pointer',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      transition: 'background 0.15s',
                    }}
                    onMouseEnter={e => { e.currentTarget.style.background = COLORS.bgHover; }}
                    onMouseLeave={e => { e.currentTarget.style.background = COLORS.bgCard; }}
                  >
                    <div>
                      <span style={{ fontFamily: FONTS.pixel, fontSize: 8, color: COLORS.text }}>{inst.name}</span>
                      <span style={{ fontFamily: FONTS.body, fontSize: 10, color: COLORS.textDim, marginLeft: 8 }}>({inst.type})</span>
                    </div>
                    {member && (
                      <span style={{
                        fontFamily: FONTS.pixel,
                        fontSize: 6,
                        color: COLORS.accent,
                        padding: '2px 6px',
                        border: `1px solid ${COLORS.accent}`,
                        borderRadius: 3,
                      }}>
                        {member.role}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
            <Divider />
          </div>
        );
      })()}

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

    </div>
  );
};
