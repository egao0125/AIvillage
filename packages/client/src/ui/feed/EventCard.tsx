import React, { useState } from 'react';
import type { VillageEvent } from './types';
import type { ChatEntry } from '../../core/GameStore';
import { ConversationExpander } from './ConversationExpander';
import { ReactionsExpander, getReactionCount } from './ReactionsExpander';
import { ConsequencesExpander } from './ConsequencesExpander';
import { gameStore } from '../../core/GameStore';
import { FONTS } from '../styles';
import { useTheme } from '../ThemeContext';

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
  const { colors } = useTheme();
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
      onMouseEnter={e => { e.currentTarget.style.background = colors.bgHover; }}
      onMouseLeave={e => { e.currentTarget.style.background = colors.bgCard; }}
      style={{
        margin: '6px 10px',
        padding: '12px 14px',
        background: colors.bgCard,
        borderRadius: 8,
        border: `1px solid ${colors.border}`,
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
          <span style={{ fontFamily: FONTS.body, fontSize: '11px', color: colors.textDim }}>
            by <span
              onClick={(e) => { e.stopPropagation(); gameStore.openAgentDetail(event.author!.id); }}
              style={{ color: colors.accent, fontWeight: 'bold', cursor: 'pointer' }}
            >{event.author.name}</span>
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
          color: colors.text,
          lineHeight: '1.6',
          whiteSpace: 'pre-wrap',
        }}
      >
        {displayText}
      </div>

      {/* Structured rule fields — always visible for rule events */}
      {event.type === 'rule' && (event.sourceData as any)?.ruleAppliesTo && (
        <div style={{ marginTop: 6, fontSize: '11px', fontFamily: FONTS.body, lineHeight: '1.5' }}>
          {(event.sourceData as any).ruleAppliesTo && (
            <div><span style={{ color: '#fbbf24', fontWeight: 'bold' }}>Applies to:</span>{' '}
              <span style={{ color: colors.textDim }}>{(event.sourceData as any).ruleAppliesTo}</span>
            </div>
          )}
          {(event.sourceData as any).ruleConsequence && (
            <div><span style={{ color: '#ef4444', fontWeight: 'bold' }}>Consequence:</span>{' '}
              <span style={{ color: colors.textDim }}>{(event.sourceData as any).ruleConsequence}</span>
            </div>
          )}
        </div>
      )}

      {/* Footer: day + reaction count hint when collapsed */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
        <span style={{ fontFamily: FONTS.pixel, fontSize: '6px', color: colors.textDim, letterSpacing: 0.5 }}>
          Day {event.day}
        </span>
        {reactionCount > 0 && !expanded && (
          <span style={{ fontFamily: FONTS.body, fontSize: '10px', color: colors.accent }}>
            {reactionCount} reaction{reactionCount === 1 ? '' : 's'}
          </span>
        )}
      </div>

      {/* Details & reactions — shown when card is expanded */}
      {expanded && <ConsequencesExpander event={event} />}
      {expanded && reactionCount > 0 && <ReactionsExpander event={event} />}

      {/* Conversation expander */}
      {event.sourceConversationId && (
        <button
          onClick={(e) => { e.stopPropagation(); setShowConversation(prev => !prev); }}
          style={{
            background: 'none',
            border: 'none',
            color: colors.accent,
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
