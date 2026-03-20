import React, { useState, useCallback } from 'react';
import { useBoard, useArtifacts } from '../../core/hooks';
import { COLORS, FONTS } from '../styles';

interface FeedItem {
  id: string;
  kind: 'rumor' | 'threat' | 'bounty' | 'newspaper' | 'propaganda' | 'manifesto' | 'poem' | 'letter' | 'law' | 'painting' | 'diary' | 'map' | 'recipe';
  icon: string;
  color: string;
  author: string;
  content: string;
  title?: string;
  day: number;
  timestamp: number;
  reactions?: { agentName: string; reaction: string }[];
  addressedTo?: string;
}

const BADGE: Record<string, { icon: string; color: string }> = {
  rumor: { icon: '\u{1F444}', color: '#a78bfa' },
  threat: { icon: '\u{1F525}', color: '#ef4444' },
  bounty: { icon: '\u{1F3AF}', color: '#f97316' },
  newspaper: { icon: '\u{1F4F0}', color: '#60a5fa' },
  propaganda: { icon: '\u{1F4E2}', color: '#ef4444' },
  manifesto: { icon: '\u{270A}', color: '#4ade80' },
  poem: { icon: '\u{270D}\u{FE0F}', color: '#a78bfa' },
  letter: { icon: '\u{1F48C}', color: '#ec4899' },
  law: { icon: '\u{2696}\u{FE0F}', color: '#fbbf24' },
  painting: { icon: '\u{1F3A8}', color: '#f97316' },
  diary: { icon: '\u{1F4D4}', color: '#9ca3af' },
  map: { icon: '\u{1F5FA}\u{FE0F}', color: '#06b6d4' },
  recipe: { icon: '\u{1F373}', color: '#84cc16' },
};

const CONTENT_TRUNCATE_LENGTH = 140;

export const GossipFeed: React.FC = () => {
  const board = useBoard();
  const artifacts = useArtifacts();
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [filterType, setFilterType] = useState<string | null>(null);

  const toggleExpand = useCallback((id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Merge board gossip + public/addressed artifacts into a unified feed
  const feed: FeedItem[] = [];

  // Board posts: rumors, threats, bounties
  for (const post of board) {
    if (post.type === 'rumor' || post.type === 'threat' || post.type === 'bounty') {
      if (post.revoked) continue;
      feed.push({
        id: post.id,
        kind: post.type,
        icon: BADGE[post.type]?.icon ?? '',
        color: BADGE[post.type]?.color ?? COLORS.textDim,
        author: post.authorName,
        content: post.content,
        day: post.day,
        timestamp: post.timestamp,
      });
    }
  }

  // Public + addressed artifacts
  for (const art of artifacts) {
    if (art.visibility !== 'public' && art.visibility !== 'addressed') continue;
    const b = BADGE[art.type];
    feed.push({
      id: art.id,
      kind: art.type as FeedItem['kind'],
      icon: b?.icon ?? '\u{1F4C4}',
      color: b?.color ?? '#9ca3af',
      author: art.creatorName,
      content: art.content,
      title: art.title,
      day: art.day,
      timestamp: art.createdAt,
      reactions: art.reactions.map(r => ({ agentName: r.agentName, reaction: r.reaction })),
      addressedTo: art.visibility === 'addressed' && art.addressedTo?.length
        ? art.addressedTo.join(', ')
        : undefined,
    });
  }

  // Sort newest first
  feed.sort((a, b) => b.timestamp - a.timestamp);

  // Apply filter
  const filtered = filterType ? feed.filter(item => item.kind === filterType) : feed;

  // Collect unique types for filter bar
  const typeSet = new Set(feed.map(item => item.kind));
  const availableTypes = Array.from(typeSet).sort();

  // Group reactions
  const groupReactions = (reactions: { agentName: string; reaction: string }[]) => {
    const groups: Map<string, string[]> = new Map();
    for (const r of reactions) {
      const existing = groups.get(r.reaction) ?? [];
      existing.push(r.agentName);
      groups.set(r.reaction, existing);
    }
    return Array.from(groups.entries());
  };

  if (feed.length === 0) {
    return (
      <div style={{ padding: 20, textAlign: 'center', color: COLORS.textDim, fontFamily: FONTS.body, fontSize: '13px' }}>
        No social activity yet.
        <br />
        <span style={{ fontSize: '11px', marginTop: 8, display: 'block' }}>
          Rumors, newspapers, propaganda, letters, and other drama will appear here.
        </span>
      </div>
    );
  }

  return (
    <div style={{ padding: '4px 0' }}>
      {/* Filter bar */}
      {availableTypes.length > 1 && (
        <div style={{
          padding: '8px 14px',
          display: 'flex',
          gap: 6,
          flexWrap: 'wrap',
          borderBottom: `1px solid ${COLORS.border}`,
        }}>
          <button
            onClick={() => setFilterType(null)}
            style={{
              fontFamily: FONTS.pixel,
              fontSize: '7px',
              padding: '3px 8px',
              borderRadius: 3,
              border: `1px solid ${filterType === null ? COLORS.accent : COLORS.border}`,
              background: filterType === null ? COLORS.accentDim : 'transparent',
              color: filterType === null ? COLORS.accent : COLORS.textDim,
              cursor: 'pointer',
              textTransform: 'uppercase',
            }}
          >
            All ({feed.length})
          </button>
          {availableTypes.map(type => {
            const badge = BADGE[type];
            const count = feed.filter(i => i.kind === type).length;
            return (
              <button
                key={type}
                onClick={() => setFilterType(filterType === type ? null : type)}
                style={{
                  fontFamily: FONTS.pixel,
                  fontSize: '7px',
                  padding: '3px 8px',
                  borderRadius: 3,
                  border: `1px solid ${filterType === type ? badge?.color ?? COLORS.accent : COLORS.border}`,
                  background: filterType === type ? (badge?.color ?? COLORS.accent) + '22' : 'transparent',
                  color: filterType === type ? badge?.color ?? COLORS.accent : COLORS.textDim,
                  cursor: 'pointer',
                  textTransform: 'uppercase',
                }}
              >
                {badge?.icon} {type} ({count})
              </button>
            );
          })}
        </div>
      )}

      {/* Feed items */}
      {filtered.map(item => {
        const isLong = item.content.length > CONTENT_TRUNCATE_LENGTH;
        const isExpanded = expandedIds.has(item.id);
        const displayContent = isLong && !isExpanded
          ? item.content.slice(0, CONTENT_TRUNCATE_LENGTH) + '...'
          : item.content;

        return (
          <div key={item.id} style={{
            margin: '6px 10px',
            padding: '12px 14px',
            background: COLORS.bgCard,
            borderRadius: 8,
            border: `1px solid ${COLORS.border}`,
          }}>
            {/* Header: badge + author */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
              <span style={{ fontSize: '14px' }}>{item.icon}</span>
              <span style={{
                fontFamily: FONTS.pixel,
                fontSize: '8px',
                padding: '2px 6px',
                borderRadius: 3,
                background: item.color + '33',
                color: item.color,
                fontWeight: 'bold',
                textTransform: 'uppercase',
              }}>
                {item.kind}
              </span>
              {item.addressedTo && (
                <span style={{
                  fontFamily: FONTS.body,
                  fontSize: '10px',
                  color: '#ec4899',
                }}>
                  To: {item.addressedTo}
                </span>
              )}
              <span style={{ fontFamily: FONTS.body, fontSize: '11px', color: COLORS.textDim, marginLeft: 'auto' }}>
                {item.author} — Day {item.day}
              </span>
            </div>

            {/* Title (if artifact) */}
            {item.title && (
              <div style={{
                fontFamily: FONTS.pixel,
                fontSize: '10px',
                color: COLORS.text,
                marginBottom: 4,
              }}>
                {item.title}
              </div>
            )}

            {/* Content */}
            <div style={{
              fontFamily: FONTS.body,
              fontSize: '12px',
              color: COLORS.textDim,
              lineHeight: '1.6',
              whiteSpace: 'pre-wrap',
            }}>
              {displayContent}
            </div>

            {/* Show more/less toggle */}
            {isLong && (
              <button
                onClick={() => toggleExpand(item.id)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: COLORS.accent,
                  fontFamily: FONTS.body,
                  fontSize: '11px',
                  cursor: 'pointer',
                  padding: '4px 0 0',
                }}
              >
                {isExpanded ? 'Show less' : 'Show more'}
              </button>
            )}

            {/* Grouped reactions */}
            {item.reactions && item.reactions.length > 0 && (
              <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {groupReactions(item.reactions).map(([reaction, names], i) => (
                  <span key={i} style={{
                    fontSize: '10px',
                    padding: '3px 8px',
                    borderRadius: 12,
                    background: COLORS.bgHover,
                    border: `1px solid ${COLORS.border}`,
                    color: COLORS.textDim,
                  }}>
                    {reaction} ({names.length})
                  </span>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};
