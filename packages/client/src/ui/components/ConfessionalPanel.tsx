import React, { useState, useMemo } from 'react';
import { useBoard, useAgents } from '../../core/hooks';
import { nameToColor, hexToString } from '../../utils/color';
import { COLORS, FONTS } from '../styles';

export const ConfessionalPanel: React.FC = () => {
  const board = useBoard();
  const agents = useAgents();
  const [filterAgentId, setFilterAgentId] = useState<string | null>(null);

  // Collect all comments from all board posts, optionally filtered by agent
  const reactions = useMemo(() => {
    const all: { agentId: string; agentName: string; content: string; timestamp: number; postContent: string; postAuthor: string }[] = [];
    for (const post of board) {
      if (!post.comments) continue;
      for (const c of post.comments) {
        if (filterAgentId && c.agentId !== filterAgentId) continue;
        all.push({
          ...c,
          postContent: post.content.length > 80 ? post.content.slice(0, 77) + '...' : post.content,
          postAuthor: post.authorName,
        });
      }
    }
    // Sort newest first
    return all.sort((a, b) => b.timestamp - a.timestamp);
  }, [board, filterAgentId]);

  const currentReaction = reactions[0];

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: `radial-gradient(ellipse at center top, #f0e8f5 0%, #f2f0ea 40%, #f5f5f0 100%)`,
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '16px 18px',
          borderBottom: `1px solid ${COLORS.border}`,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}
      >
        <span style={{ fontSize: '18px' }}>&#128172;</span>
        <span
          style={{
            fontFamily: FONTS.pixel,
            fontSize: '10px',
            color: '#a855f7',
            letterSpacing: 2,
          }}
        >
          REACTIONS
        </span>
      </div>

      {/* Agent filter */}
      <div style={{ padding: '8px 18px' }}>
        <select
          value={filterAgentId || ''}
          onChange={e => setFilterAgentId(e.target.value || null)}
          style={{
            width: '100%',
            padding: '6px 10px',
            background: COLORS.bgCard,
            color: COLORS.text,
            border: `1px solid ${COLORS.border}`,
            borderRadius: 4,
            fontFamily: FONTS.body,
            fontSize: '13px',
          }}
        >
          <option value="">All Villagers</option>
          {agents.filter(a => a.alive !== false).map(a => (
            <option key={a.id} value={a.id}>{a.config.name}</option>
          ))}
        </select>
      </div>

      {/* Spotlight reaction */}
      {currentReaction ? (
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '20px 24px',
            textAlign: 'center',
          }}
        >
          {/* Agent avatar */}
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: '50%',
              background: hexToString(nameToColor(currentReaction.agentName)),
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '24px',
              fontWeight: 'bold',
              color: '#fff',
              marginBottom: 12,
              boxShadow: `0 0 20px ${hexToString(nameToColor(currentReaction.agentName))}40`,
            }}
          >
            {currentReaction.agentName[0]}
          </div>

          {/* Agent name */}
          <div
            style={{
              fontFamily: FONTS.pixel,
              fontSize: '11px',
              color: hexToString(nameToColor(currentReaction.agentName)),
              marginBottom: 8,
            }}
          >
            {currentReaction.agentName}
          </div>

          {/* What they reacted to */}
          <div
            style={{
              fontFamily: FONTS.body,
              fontSize: '11px',
              color: COLORS.textDim,
              marginBottom: 12,
              maxWidth: 340,
            }}
          >
            re: {currentReaction.postAuthor} &mdash; &ldquo;{currentReaction.postContent}&rdquo;
          </div>

          {/* Reaction text */}
          <div
            style={{
              fontFamily: FONTS.body,
              fontSize: '16px',
              color: '#f3e8ff',
              lineHeight: 1.7,
              fontStyle: 'italic',
              maxWidth: 340,
            }}
          >
            &ldquo;{currentReaction.content}&rdquo;
          </div>

          {/* Timestamp */}
          <div
            style={{
              fontFamily: FONTS.body,
              fontSize: '11px',
              color: '#666',
              marginTop: 16,
            }}
          >
            {new Date(currentReaction.timestamp).toLocaleTimeString()}
          </div>
        </div>
      ) : (
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: COLORS.textDim,
            fontFamily: FONTS.body,
            fontSize: '14px',
            fontStyle: 'italic',
          }}
        >
          Waiting for reactions...
        </div>
      )}

      {/* Reaction timeline */}
      <div
        style={{
          maxHeight: 200,
          overflowY: 'auto',
          borderTop: `1px solid ${COLORS.border}`,
        }}
      >
        {reactions.slice(0, 20).map((r, i) => (
          <div
            key={`${r.agentId}-${r.timestamp}-${i}`}
            style={{
              padding: '10px 18px',
              borderBottom: `1px solid rgba(255,255,255,0.03)`,
              background: i === 0 ? 'rgba(168, 85, 247, 0.1)' : 'transparent',
            }}
          >
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <span
                style={{
                  fontFamily: FONTS.pixel,
                  fontSize: '8px',
                  color: hexToString(nameToColor(r.agentName)),
                  flexShrink: 0,
                  paddingTop: 2,
                }}
              >
                {r.agentName}
              </span>
              <span
                style={{
                  fontFamily: FONTS.body,
                  fontSize: '12px',
                  color: '#b0a0c0',
                  fontStyle: 'italic',
                  lineHeight: 1.4,
                }}
              >
                {r.content.length > 100 ? r.content.substring(0, 97) + '...' : r.content}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
