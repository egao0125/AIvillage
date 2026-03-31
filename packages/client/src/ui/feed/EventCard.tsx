import React, { useState } from 'react';
import type { VillageEvent } from './types';
import type { ChatEntry } from '../../core/GameStore';
import { ConversationExpander } from './ConversationExpander';
import { ConsequencesExpander } from './ConsequencesExpander';
import { COLORS, FONTS } from '../styles';

interface EventCardProps {
  event: VillageEvent;
  chatLog: ChatEntry[];
}

export const EventCard: React.FC<EventCardProps> = ({ event, chatLog }) => {
  const [showConversation, setShowConversation] = useState(false);
  const [showDetails, setShowDetails] = useState(false);

  return (
    <div
      style={{
        margin: '6px 10px',
        padding: '12px 14px',
        background: COLORS.bgCard,
        borderRadius: 8,
        border: `1px solid ${COLORS.border}`,
      }}
    >
      {/* Header: icon + type badge + agents + day */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <span style={{ fontSize: '14px' }}>{event.icon}</span>
        <span
          style={{
            fontFamily: FONTS.pixel,
            fontSize: '7px',
            padding: '2px 6px',
            borderRadius: 3,
            background: event.color + '33',
            color: event.color,
            fontWeight: 'bold',
            textTransform: 'uppercase',
          }}
        >
          {event.type.replace('_', ' ')}
        </span>
        <span
          style={{
            fontFamily: FONTS.body,
            fontSize: '11px',
            color: COLORS.textDim,
            marginLeft: 'auto',
            whiteSpace: 'nowrap',
          }}
        >
          Day {event.day}
        </span>
      </div>

      {/* Headline */}
      <div
        style={{
          fontFamily: FONTS.body,
          fontSize: '12px',
          color: COLORS.text,
          lineHeight: '1.5',
        }}
      >
        {event.headline}
      </div>

      {/* Expandable links */}
      <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
        {event.sourceConversationId && (
          <button
            onClick={() => setShowConversation(prev => !prev)}
            style={{
              background: 'none',
              border: 'none',
              color: COLORS.accent,
              fontFamily: FONTS.body,
              fontSize: '11px',
              cursor: 'pointer',
              padding: 0,
            }}
          >
            {showConversation ? '▾ Hide conversation' : '▸ View conversation'}
          </button>
        )}
        {!!event.sourceData && (
          <button
            onClick={() => setShowDetails(prev => !prev)}
            style={{
              background: 'none',
              border: 'none',
              color: COLORS.accent,
              fontFamily: FONTS.body,
              fontSize: '11px',
              cursor: 'pointer',
              padding: 0,
            }}
          >
            {showDetails ? '▾ Hide details' : '▸ Details'}
          </button>
        )}
      </div>

      {/* Layer 2: Conversation */}
      {showConversation && event.sourceConversationId && (
        <ConversationExpander
          conversationId={event.sourceConversationId}
          chatLog={chatLog}
        />
      )}

      {/* Layer 3: Consequences / details */}
      {showDetails && <ConsequencesExpander event={event} />}
    </div>
  );
};
