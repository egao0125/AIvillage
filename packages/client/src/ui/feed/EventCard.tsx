import React, { useState } from 'react';
import type { VillageEvent } from './types';
import type { ChatEntry } from '../../core/GameStore';
import { ConversationExpander } from './ConversationExpander';
import { ReactionsExpander, getReactionCount } from './ReactionsExpander';
import { COLORS, FONTS } from '../styles';

const TRUNCATE_LENGTH = 140;

const STATUS_STYLES: Record<string, { bg: string; color: string; label: string }> = {
  passed:   { bg: '#4ade8033', color: '#4ade80', label: 'PASSED' },
  rejected: { bg: '#ef444433', color: '#ef4444', label: 'REJECTED' },
  repealed: { bg: '#6b728033', color: '#9ca3af', label: 'REPEALED' },
};

interface EventCardProps {
  event: VillageEvent;
  chatLog: ChatEntry[];
}

export const EventCard: React.FC<EventCardProps> = ({ event, chatLog }) => {
  const [showConversation, setShowConversation] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const reactionCount = getReactionCount(event);
  const isLong = event.headline.length > TRUNCATE_LENGTH;
  const isExpandable = isLong || reactionCount > 0;
  const displayText = isLong && !expanded
    ? event.headline.slice(0, TRUNCATE_LENGTH) + '...'
    : event.headline;

  const statusStyle = event.status ? STATUS_STYLES[event.status] : null;

  return (
    <div
      onClick={() => { if (isExpandable) setExpanded(prev => !prev); }}
      onMouseEnter={e => { e.currentTarget.style.background = COLORS.bgHover; }}
      onMouseLeave={e => { e.currentTarget.style.background = COLORS.bgCard; }}
      style={{
        margin: '6px 10px',
        padding: '12px 14px',
        background: COLORS.bgCard,
        borderRadius: 8,
        border: `1px solid ${COLORS.border}`,
        cursor: isExpandable ? 'pointer' : undefined,
        transition: 'background 0.15s ease',
      }}
    >
      {/* Header: icon + type badge + "by author" ... status flag (top right) */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
        <span style={{ fontSize: '14px' }}>{event.icon}</span>
        <span
          style={{
            fontFamily: FONTS.pixel,
            fontSize: '9px',
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
        {event.author && event.author.id !== 'system' && (
          <span style={{ fontFamily: FONTS.body, fontSize: '11px', color: COLORS.textDim }}>
            by <span style={{ color: COLORS.text, fontWeight: 'bold' }}>{event.author.name}</span>
          </span>
        )}
        {statusStyle && (
          <span
            style={{
              fontFamily: FONTS.pixel,
              fontSize: '9px',
              padding: '2px 6px',
              borderRadius: 3,
              background: statusStyle.bg,
              color: statusStyle.color,
              fontWeight: 'bold',
              marginLeft: 'auto',
            }}
          >
            {statusStyle.label}
          </span>
        )}
      </div>

      {/* Content — truncated, click card to expand */}
      <div
        style={{
          fontFamily: FONTS.body,
          fontSize: '12px',
          color: COLORS.text,
          lineHeight: '1.6',
          whiteSpace: 'pre-wrap',
        }}
      >
        {displayText}
      </div>

      {/* Footer: day + reaction count hint when collapsed */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
        <span style={{ fontFamily: FONTS.pixel, fontSize: '6px', color: COLORS.textDim, letterSpacing: 0.5 }}>
          Day {event.day}
        </span>
        {reactionCount > 0 && !expanded && (
          <span style={{ fontFamily: FONTS.body, fontSize: '10px', color: COLORS.accent }}>
            {reactionCount} reaction{reactionCount === 1 ? '' : 's'}
          </span>
        )}
      </div>

      {/* Reactions — shown when card is expanded */}
      {expanded && reactionCount > 0 && <ReactionsExpander event={event} />}

      {/* Conversation expander */}
      {event.sourceConversationId && (
        <button
          onClick={(e) => { e.stopPropagation(); setShowConversation(prev => !prev); }}
          style={{
            background: 'none',
            border: 'none',
            color: COLORS.accent,
            fontFamily: FONTS.body,
            fontSize: '11px',
            cursor: 'pointer',
            padding: 0,
            marginTop: 8,
            display: 'block',
          }}
        >
          {showConversation ? '▾ Hide conversation' : '▸ View conversation'}
        </button>
      )}
      {showConversation && event.sourceConversationId && (
        <ConversationExpander conversationId={event.sourceConversationId} chatLog={chatLog} />
      )}
    </div>
  );
};
