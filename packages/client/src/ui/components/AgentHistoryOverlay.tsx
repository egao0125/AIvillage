import React, { useEffect, useState } from 'react';
import { useAgentEvents, useInstitutions, useBoard } from '../../core/hooks';
import { FONTS } from '../styles';

const SECTION_HEADER: React.CSSProperties = {
  fontFamily: FONTS.pixel,
  fontSize: 8,
  color: '#e8b800',
  letterSpacing: 2,
  marginBottom: 8,
  marginTop: 14,
};

const BODY_FONT = 'Inter, -apple-system, BlinkMacSystemFont, sans-serif';

interface AgentHistoryOverlayProps {
  agentId: string;
  onClose: () => void;
}

export const AgentHistoryOverlay: React.FC<AgentHistoryOverlayProps> = ({ agentId, onClose }) => {
  // Character arc
  const [arc, setArc] = useState<string | null>(null);
  const [arcLoading, setArcLoading] = useState(true);
  const [arcExpanded, setArcExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setArcLoading(true);
    setArc(null);
    setArcExpanded(false);

    fetch(`/api/agents/${agentId}/arc-summary`)
      .then(res => { if (!res.ok) throw new Error(); return res.json(); })
      .then((data: { summary?: string }) => {
        if (!cancelled) { setArc(data.summary ?? null); setArcLoading(false); }
      })
      .catch(() => { if (!cancelled) setArcLoading(false); });

    return () => { cancelled = true; };
  }, [agentId]);

  // Events, institutions, reactions
  const events = useAgentEvents(agentId);
  const institutions = useInstitutions();
  const board = useBoard();

  const agentInstitutions = institutions.filter(
    inst => !inst.dissolved && inst.members.some(m => m.agentId === agentId)
  );

  const reactions = board
    .filter(post => post.comments?.some(c => c.agentId === agentId))
    .slice(0, 10);

  const recentEvents = events.slice(0, 15);

  const arcText = arc || 'Their story is just beginning...';
  const arcIsLong = arcText.length > 120;
  const arcDisplay = arcIsLong && !arcExpanded ? arcText.slice(0, 120) + '...' : arcText;

  return (
    <>
      {/* Backdrop — click to close */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 59,
        }}
      />

      {/* Overlay panel */}
      <div style={{
        position: 'absolute',
        bottom: 64,
        left: 252,
        width: 320,
        maxHeight: '55vh',
        overflowY: 'auto',
        padding: 16,
        background: 'rgba(15, 15, 26, 0.95)',
        backdropFilter: 'blur(16px)',
        border: '1px solid rgba(100, 255, 218, 0.12)',
        borderRadius: 12,
        zIndex: 60,
        pointerEvents: 'auto',
        overscrollBehavior: 'contain',
      }}>
        {/* Close button */}
        <button
          onClick={onClose}
          style={{
            position: 'absolute',
            top: 10,
            right: 10,
            background: 'none',
            border: 'none',
            color: '#8888a8',
            cursor: 'pointer',
            fontSize: 14,
            fontFamily: BODY_FONT,
            padding: 0,
          }}
        >
          ✕
        </button>

        {/* Character Arc */}
        <div style={SECTION_HEADER}>CHARACTER ARC</div>
        {arcLoading ? (
          <div style={{ fontSize: 11, fontFamily: BODY_FONT, color: '#555570', fontStyle: 'italic' }}>
            Loading...
          </div>
        ) : (
          <div>
            <div style={{
              fontSize: 12,
              fontFamily: BODY_FONT,
              color: '#aaaacc',
              fontStyle: 'italic',
              lineHeight: 1.5,
            }}>
              {arcDisplay}
            </div>
            {arcIsLong && (
              <button
                onClick={() => setArcExpanded(v => !v)}
                style={{
                  background: 'none',
                  border: 'none',
                  padding: 0,
                  cursor: 'pointer',
                  fontSize: 10,
                  fontFamily: BODY_FONT,
                  color: '#64ffda',
                  marginTop: 4,
                }}
              >
                {arcExpanded ? 'Show less' : 'Read more'}
              </button>
            )}
          </div>
        )}

        {/* Events */}
        {recentEvents.length > 0 && (
          <>
            <div style={SECTION_HEADER}>EVENTS</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {recentEvents.map(evt => (
                <div key={evt.id} style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 6,
                  fontSize: 11,
                  fontFamily: BODY_FONT,
                }}>
                  <span style={{ flexShrink: 0 }}>{evt.icon}</span>
                  <span style={{ color: '#ccccdd', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {evt.headline.length > 80 ? evt.headline.slice(0, 78) + '...' : evt.headline}
                  </span>
                  <span style={{ color: '#555570', fontSize: 10, flexShrink: 0 }}>
                    D{evt.day}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}

        {/* Institutions */}
        {agentInstitutions.length > 0 && (
          <>
            <div style={SECTION_HEADER}>INSTITUTIONS</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {agentInstitutions.map(inst => {
                const member = inst.members.find(m => m.agentId === agentId);
                return (
                  <div key={inst.id} style={{
                    background: 'rgba(255,255,255,0.03)',
                    borderRadius: 4,
                    padding: '6px 8px',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}>
                    <div>
                      <div style={{ fontFamily: FONTS.pixel, fontSize: 8, color: '#e8e8f0' }}>
                        {inst.name}
                      </div>
                      <div style={{ fontFamily: BODY_FONT, fontSize: 10, color: '#555570' }}>
                        {inst.type}
                      </div>
                    </div>
                    {member?.role && (
                      <span style={{
                        fontFamily: FONTS.pixel,
                        fontSize: 6,
                        color: '#64ffda',
                        border: '1px solid rgba(100,255,218,0.3)',
                        borderRadius: 3,
                        padding: '2px 5px',
                      }}>
                        {member.role}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}

        {/* Reactions */}
        {reactions.length > 0 && (
          <>
            <div style={SECTION_HEADER}>REACTIONS</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {reactions.map(post => {
                const comment = post.comments?.find(c => c.agentId === agentId);
                return (
                  <div key={post.id} style={{
                    background: 'rgba(255,255,255,0.03)',
                    borderRadius: 4,
                    padding: '6px 8px',
                  }}>
                    <div style={{ fontSize: 11, fontFamily: BODY_FONT, color: '#aaaacc', marginBottom: 4 }}>
                      {post.content.length > 60 ? post.content.slice(0, 58) + '...' : post.content}
                    </div>
                    {comment && (
                      <div style={{
                        fontSize: 10,
                        fontFamily: BODY_FONT,
                        color: '#8888a8',
                        fontStyle: 'italic',
                        borderLeft: '2px solid rgba(100,255,218,0.2)',
                        paddingLeft: 8,
                      }}>
                        {comment.content}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </>
  );
};
