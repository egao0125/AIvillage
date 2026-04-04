import React, { useState } from 'react';
import type { VillageEvent } from './types';
import type { ChatEntry } from '../../core/GameStore';
import type { Institution } from '@ai-village/shared';
import { ConversationExpander } from './ConversationExpander';
import { ReactionsExpander, getReactionCount } from './ReactionsExpander';
import { useAgents } from '../../core/hooks';
import { gameStore } from '../../core/GameStore';
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
  const agents = useAgents();

  const isInstitution = event.type === 'institution' && event.sourceData;
  const inst = isInstitution ? event.sourceData as Institution : null;

  const reactionCount = getReactionCount(event);
  const isLong = !isInstitution && event.headline.length > TRUNCATE_LENGTH;
  const isExpandable = isInstitution || isLong || reactionCount > 0;
  const displayText = isLong && !expanded
    ? event.headline.slice(0, TRUNCATE_LENGTH) + '...'
    : event.headline;

  const statusStyle = event.status ? STATUS_STYLES[event.status] : null;

  // Helper: resolve agent name from ID
  const resolveAgentName = (agentId: string): string => {
    const agent = agents.find(a => a.id === agentId);
    return agent?.config.name ?? 'Unknown';
  };

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
            by <span
              onClick={(e) => { e.stopPropagation(); gameStore.openAgentDetail(event.author!.id); }}
              style={{ color: COLORS.accent, fontWeight: 'bold', cursor: 'pointer' }}
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

      {/* Institution-specific structured content */}
      {inst ? (
        <div style={{ fontFamily: FONTS.body, fontSize: '12px', color: COLORS.text, lineHeight: '1.6' }}>
          {/* Name + type */}
          <div style={{ fontWeight: 'bold', fontSize: '13px', marginBottom: 4 }}>
            {inst.name}
            <span style={{
              fontFamily: FONTS.pixel,
              fontSize: '7px',
              color: COLORS.textDim,
              marginLeft: 8,
              fontWeight: 'normal',
              letterSpacing: 1,
              textTransform: 'uppercase',
            }}>
              {inst.type}
            </span>
          </div>

          {/* Aim / description */}
          {inst.description && (
            <div style={{ color: COLORS.textDim, fontSize: '11px', marginBottom: 6 }}>
              {inst.description.length > 120 && !expanded
                ? inst.description.slice(0, 120) + '...'
                : inst.description}
            </div>
          )}

          {/* Leader */}
          <div style={{ fontSize: '11px', color: COLORS.textDim, marginBottom: 2 }}>
            <span style={{ fontFamily: FONTS.pixel, fontSize: '7px', color: '#8b5cf6', letterSpacing: 0.5 }}>LEADER </span>
            <span
              onClick={(e) => { e.stopPropagation(); gameStore.openAgentDetail(inst.founderId); }}
              style={{ color: COLORS.accent, cursor: 'pointer', fontWeight: 'bold' }}
            >
              {resolveAgentName(inst.founderId)}
            </span>
          </div>

          {/* Members */}
          <div style={{ fontSize: '11px', color: COLORS.textDim }}>
            <span style={{ fontFamily: FONTS.pixel, fontSize: '7px', color: '#8b5cf6', letterSpacing: 0.5 }}>MEMBERS </span>
            {inst.members.map((m, i) => (
              <span key={m.agentId}>
                {i > 0 && ', '}
                <span
                  onClick={(e) => { e.stopPropagation(); gameStore.openAgentDetail(m.agentId); }}
                  style={{ color: COLORS.text, cursor: 'pointer' }}
                >
                  {resolveAgentName(m.agentId)}
                </span>
                {m.role && m.role !== 'member' && (
                  <span style={{ color: '#8b5cf680', fontSize: '10px' }}> ({m.role})</span>
                )}
              </span>
            ))}
          </div>

          {/* Rules — shown when expanded */}
          {expanded && inst.rules && inst.rules.length > 0 && (
            <div style={{ marginTop: 10, paddingTop: 8, borderTop: `1px solid ${COLORS.border}` }}>
              <div style={{ fontFamily: FONTS.pixel, fontSize: '7px', color: '#fbbf24', letterSpacing: 1, marginBottom: 6 }}>
                RULES
              </div>
              {inst.rules.map((rule, i) => (
                <div
                  key={i}
                  style={{
                    fontSize: '11px',
                    color: COLORS.textDim,
                    padding: '4px 8px',
                    marginBottom: 3,
                    background: 'rgba(255,255,255,0.03)',
                    borderRadius: 4,
                    lineHeight: 1.5,
                  }}
                >
                  {rule}
                </div>
              ))}
            </div>
          )}

          {/* Expand hint */}
          {!expanded && inst.rules && inst.rules.length > 0 && (
            <div style={{ fontFamily: FONTS.body, fontSize: '10px', color: COLORS.accent, marginTop: 6 }}>
              {inst.rules.length} rule{inst.rules.length === 1 ? '' : 's'} — click to view
            </div>
          )}
        </div>
      ) : (
        /* Default content — truncated, click card to expand */
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
      )}

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
