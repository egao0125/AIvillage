import React, { useState } from 'react';
import type { VillageEvent } from './types';
import type { ChatEntry } from '../../core/GameStore';
import { ConversationExpander } from './ConversationExpander';
import { ConsequencesExpander } from './ConsequencesExpander';
import { COLORS, FONTS } from '../styles';

const TRUNCATE_LENGTH = 140;

// Event types that have structured data worth showing in the details expander
const TYPES_WITH_DETAILS = new Set(['rule', 'election', 'institution']);

interface EventCardProps {
  event: VillageEvent;
  chatLog: ChatEntry[];
}

export const EventCard: React.FC<EventCardProps> = ({ event, chatLog }) => {
  const [showConversation, setShowConversation] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [contentExpanded, setContentExpanded] = useState(false);

  const hasDetail = !!event.detail;
  const isLong = hasDetail && event.detail!.length > TRUNCATE_LENGTH;
  const displayContent = hasDetail
    ? (isLong && !contentExpanded ? event.detail!.slice(0, TRUNCATE_LENGTH) + '...' : event.detail)
    : null;

  const hasStructuredDetails = TYPES_WITH_DETAILS.has(event.type) && !!event.sourceData;

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
      {/* Header: icon + type badge + day */}
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
          fontWeight: 'bold',
        }}
      >
        {event.headline}
      </div>

      {/* Full content — with show more/less */}
      {displayContent && (
        <div
          style={{
            fontFamily: FONTS.body,
            fontSize: '12px',
            color: COLORS.textDim,
            lineHeight: '1.6',
            marginTop: 4,
            whiteSpace: 'pre-wrap',
          }}
        >
          {displayContent}
          {isLong && (
            <button
              onClick={() => setContentExpanded(prev => !prev)}
              style={{
                background: 'none',
                border: 'none',
                color: COLORS.accent,
                fontFamily: FONTS.body,
                fontSize: '11px',
                cursor: 'pointer',
                padding: '2px 0 0',
                marginLeft: 4,
              }}
            >
              {contentExpanded ? 'Show less' : 'Show more'}
            </button>
          )}
        </div>
      )}

      {/* Expandable links — only show if there's something to expand */}
      {(event.sourceConversationId || hasStructuredDetails) && (
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
          {hasStructuredDetails && (
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
      )}

      {/* Layer 2: Conversation */}
      {showConversation && event.sourceConversationId && (
        <ConversationExpander
          conversationId={event.sourceConversationId}
          chatLog={chatLog}
        />
      )}

      {/* Layer 3: Structured details */}
      {showDetails && hasStructuredDetails && <ConsequencesExpander event={event} />}
    </div>
  );
};
