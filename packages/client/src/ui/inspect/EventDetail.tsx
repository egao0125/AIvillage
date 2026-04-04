import React from 'react';
import { FONTS } from '../styles';
import { useTheme } from '../ThemeContext';
import { gameStore } from '../../core/GameStore';
import { useEventFeed, useChatLog, useAgentsMap } from '../../core/hooks';
import { nameToColor, hexToString } from '../../utils/color';
import { EVENT_BADGES } from '../feed/types';

export const EventDetail: React.FC<{ eventId: string }> = ({ eventId }) => {
  const { colors } = useTheme();
  const events = useEventFeed();
  const chatLog = useChatLog();
  const agentsMap = useAgentsMap();

  const event = events.find((e) => e.id === eventId);

  if (!event) {
    return <div style={{ fontFamily: FONTS.body, fontSize: 13, color: colors.textDim, padding: 16 }}>Event not found</div>;
  }

  const badge = EVENT_BADGES[event.type];

  // Conversation messages if available
  const conversation = event.sourceConversationId
    ? chatLog.filter((c) => c.conversationId === event.sourceConversationId)
    : [];

  return (
    <div>
      {/* Event card */}
      <div style={{ backgroundColor: colors.bgCard, borderRadius: 4, padding: 12, marginBottom: 16 }}>
        {/* Type badge */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <span style={{
            fontFamily: FONTS.body,
            fontSize: 10,
            color: badge?.color ?? colors.text,
            backgroundColor: (badge?.color ?? colors.text) + '22',
            padding: '2px 8px',
            borderRadius: 3,
            textTransform: 'capitalize',
          }}>
            {event.icon} {event.type}
          </span>
          <span style={{ fontFamily: FONTS.body, fontSize: 10, color: colors.textDim, marginLeft: 'auto' }}>
            Day {event.day}
          </span>
        </div>

        {/* Author */}
        {event.author && (
          <div
            style={{ fontFamily: FONTS.body, fontSize: 11, color: colors.accent, cursor: 'pointer', marginBottom: 6 }}
            onClick={() => gameStore.drillToAgentDetail(event.author!.id)}
          >
            {event.author.name}
          </div>
        )}

        {/* Full headline/text */}
        <div style={{ fontFamily: FONTS.body, fontSize: 13, color: colors.text, lineHeight: 1.6 }}>
          {event.headline}
        </div>
      </div>

      {/* Participants */}
      {event.agentIds.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontFamily: FONTS.pixel, fontSize: 8, color: colors.textDim, letterSpacing: 2, marginBottom: 8 }}>
            PARTICIPANTS
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {event.agentIds.map((aid) => {
              const a = agentsMap.get(aid);
              const name = a?.config.name ?? 'Unknown';
              return (
                <div
                  key={aid}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                    cursor: 'pointer',
                    backgroundColor: colors.bgCard,
                    padding: '3px 8px',
                    borderRadius: 3,
                  }}
                  onClick={() => gameStore.drillToAgentDetail(aid)}
                >
                  <div style={{
                    width: 18,
                    height: 18,
                    borderRadius: '50%',
                    backgroundColor: hexToString(nameToColor(name)),
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#fff',
                    fontSize: 9,
                    fontWeight: 'bold',
                    fontFamily: FONTS.body,
                  }}>
                    {name.charAt(0)}
                  </div>
                  <span style={{ fontFamily: FONTS.body, fontSize: 11, color: colors.accent }}>{name}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Conversation */}
      {conversation.length > 0 && (
        <div>
          <div style={{ fontFamily: FONTS.pixel, fontSize: 8, color: colors.textDim, letterSpacing: 2, marginBottom: 8 }}>
            CONVERSATION
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {conversation.map((msg) => (
              <div key={msg.id} style={{ fontFamily: FONTS.body, fontSize: 11, color: colors.text }}>
                <span
                  style={{ color: hexToString(nameToColor(msg.agentName)), cursor: 'pointer', fontWeight: 'bold' }}
                  onClick={() => gameStore.drillToAgentDetail(msg.agentId)}
                >
                  {msg.agentName}:
                </span>{' '}
                {msg.message}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
