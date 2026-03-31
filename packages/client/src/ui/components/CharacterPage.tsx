import React, { useEffect, useState } from 'react';
import { useCharacterPageAgentId, useAgents } from '../../core/hooks';
import { gameStore } from '../../core/GameStore';
import { nameToColor, hexToString } from '../../utils/color';
import { COLORS, FONTS } from '../styles';
import type { CharacterTimelineEvent } from '@ai-village/shared';

const API_BASE = '';

export const CharacterPage: React.FC = () => {
  const agentId = useCharacterPageAgentId();
  const agents = useAgents();
  const [timeline, setTimeline] = useState<CharacterTimelineEvent[]>([]);
  const [arcSummary, setArcSummary] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [hasError, setHasError] = useState(false);

  const agent = agents.find(a => a.id === agentId);

  useEffect(() => {
    if (!agentId) return;
    setLoading(true);
    setHasError(false);
    setArcSummary(null);
    setTimeline([]);

    // Fetch timeline and arc summary in parallel
    Promise.all([
      fetch(`${API_BASE}/api/agents/${agentId}/timeline?limit=50`).then(r => {
        if (!r.ok) throw new Error(`Timeline fetch failed: ${r.status}`);
        return r.json();
      }),
      fetch(`${API_BASE}/api/agents/${agentId}/arc-summary`).then(r => {
        if (!r.ok) throw new Error(`Arc summary fetch failed: ${r.status}`);
        return r.json();
      }),
    ]).then(([timelineData, arcData]) => {
      setTimeline(timelineData);
      setArcSummary(arcData.summary || null);
    }).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[CharacterPage] Failed to load agent data:', message);
      setHasError(true);
    }).finally(() => {
      setLoading(false);
    });
  }, [agentId]);

  if (!agentId || !agent) return null;

  const color = hexToString(nameToColor(agent.config.name));

  const moodLabels: Record<string, string> = {
    neutral: 'Calm',
    happy: 'Happy',
    angry: 'Angry',
    sad: 'Sad',
    anxious: 'Anxious',
    excited: 'Excited',
    scheming: 'Scheming',
    afraid: 'Afraid',
  };

  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        right: 420,
        bottom: 0,
        width: 500,
        zIndex: 20,
        background: COLORS.bg,
        borderLeft: `1px solid ${COLORS.border}`,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        animation: 'slideInRight 0.3s ease-out',
      }}
    >
      {/* Hero header */}
      <div
        style={{
          padding: '24px 20px',
          background: `linear-gradient(135deg, ${color}20, ${COLORS.bg})`,
          borderBottom: `1px solid ${COLORS.border}`,
        }}
      >
        {/* Close button */}
        <button
          onClick={() => gameStore.closeCharacterPage()}
          style={{
            position: 'absolute',
            top: 12,
            right: 12,
            background: 'none',
            border: 'none',
            color: COLORS.textDim,
            fontSize: '20px',
            cursor: 'pointer',
            padding: 4,
          }}
        >
          &times;
        </button>

        <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
          {/* Large avatar */}
          <div
            style={{
              width: 72,
              height: 72,
              borderRadius: '50%',
              background: color,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '32px',
              fontWeight: 'bold',
              color: '#fff',
              flexShrink: 0,
              boxShadow: `0 0 24px ${color}40`,
            }}
          >
            {agent.config.name[0]}
          </div>

          <div>
            <div style={{ fontFamily: FONTS.pixel, fontSize: '14px', color: COLORS.text, marginBottom: 6 }}>
              {agent.alive === false ? '\u{1F480} ' : ''}{agent.config.name}
            </div>
            {agent.config.occupation && (
              <div style={{ fontFamily: FONTS.body, fontSize: '14px', color: COLORS.textDim, marginBottom: 4 }}>
                {agent.config.occupation}, age {agent.config.age}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span
                style={{
                  fontFamily: FONTS.pixel,
                  fontSize: '8px',
                  color: '#fff',
                  background: `${color}80`,
                  padding: '3px 8px',
                  borderRadius: 10,
                }}
              >
                {moodLabels[agent.mood] || agent.mood}
              </span>
              <span
                style={{
                  fontFamily: FONTS.body,
                  fontSize: '12px',
                  color: COLORS.textDim,
                }}
              >
                {agent.currentAction}
              </span>
            </div>
          </div>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 0 }}>
        {/* Character arc */}
        <div style={{ padding: '16px 20px', borderBottom: `1px solid ${COLORS.border}` }}>
          <div style={{ fontFamily: FONTS.pixel, fontSize: '9px', color: COLORS.textAccent, marginBottom: 10, letterSpacing: 1 }}>
            CHARACTER ARC
          </div>
          {loading ? (
            <div style={{ height: 60, background: `${COLORS.bgCard}`, borderRadius: 4, animation: 'pulse 1.5s infinite' }} />
          ) : hasError ? (
            <div style={{ fontFamily: FONTS.body, fontSize: '12px', color: COLORS.warning, fontStyle: 'italic' }}>
              Failed to load character data. Check server connection.
            </div>
          ) : (
            <div style={{ fontFamily: FONTS.body, fontSize: '13px', color: COLORS.text, lineHeight: 1.7 }}>
              {arcSummary || 'Their story is just beginning...'}
            </div>
          )}
        </div>

        {/* Relationships */}
        {agent.mentalModels && agent.mentalModels.length > 0 && (
          <div style={{ padding: '16px 20px', borderBottom: `1px solid ${COLORS.border}` }}>
            <div style={{ fontFamily: FONTS.pixel, fontSize: '9px', color: COLORS.textAccent, marginBottom: 10, letterSpacing: 1 }}>
              RELATIONSHIPS
            </div>
            {agent.mentalModels.map(model => {
              const target = agents.find(a => a.id === model.targetId);
              if (!target) return null;
              const targetColor = hexToString(nameToColor(target.config.name));
              const trustPct = ((model.trust + 100) / 200) * 100;
              const trustColor = model.trust > 30 ? '#4ade80' : model.trust < -30 ? '#ef4444' : '#fbbf24';

              return (
                <div
                  key={model.targetId}
                  onClick={() => gameStore.openCharacterPage(model.targetId)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '8px 0',
                    cursor: 'pointer',
                    borderBottom: '1px solid rgba(255,255,255,0.03)',
                  }}
                >
                  <div
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: '50%',
                      background: targetColor,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: '12px',
                      fontWeight: 'bold',
                      color: '#fff',
                      flexShrink: 0,
                    }}
                  >
                    {target.config.name[0]}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontFamily: FONTS.body, fontSize: '13px', color: COLORS.text }}>
                      {target.config.name}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3 }}>
                      <div style={{ flex: 1, height: 4, background: COLORS.bgCard, borderRadius: 2, overflow: 'hidden' }}>
                        <div style={{ width: `${trustPct}%`, height: '100%', background: trustColor, borderRadius: 2 }} />
                      </div>
                      <span style={{ fontFamily: FONTS.body, fontSize: '11px', color: COLORS.textDim, flexShrink: 0 }}>
                        {model.emotionalStance}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Stats */}
        <div style={{ padding: '16px 20px', borderBottom: `1px solid ${COLORS.border}` }}>
          <div style={{ fontFamily: FONTS.pixel, fontSize: '9px', color: COLORS.textAccent, marginBottom: 10, letterSpacing: 1 }}>
            STATS
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            {agent.vitals && (
              <>
                <StatBar label="Health" value={agent.vitals.health} color="#4ade80" />
                <StatBar label="Energy" value={agent.vitals.energy} color="#60a5fa" />
                <StatBar label="Hunger" value={agent.vitals.hunger} color="#f97316" invert />
              </>
            )}
            {agent.currency !== undefined && (
              <div style={{ fontFamily: FONTS.body, fontSize: '13px', color: COLORS.gold }}>
                {agent.currency} gold
              </div>
            )}
          </div>
          {agent.inventory && agent.inventory.length > 0 && (
            <div style={{ marginTop: 10, fontFamily: FONTS.body, fontSize: '12px', color: COLORS.textDim }}>
              Inventory: {agent.inventory.map(i => i.name).join(', ')}
            </div>
          )}
          {agent.skills && agent.skills.length > 0 && (
            <div style={{ marginTop: 6, fontFamily: FONTS.body, fontSize: '12px', color: COLORS.textDim }}>
              Skills: {agent.skills.map(s => `${s.name} Lv${s.level}`).join(', ')}
            </div>
          )}
        </div>

        {/* Recent activity timeline */}
        <div style={{ padding: '16px 20px' }}>
          <div style={{ fontFamily: FONTS.pixel, fontSize: '9px', color: COLORS.textAccent, marginBottom: 10, letterSpacing: 1 }}>
            RECENT ACTIVITY
          </div>
          {timeline.length === 0 ? (
            <div style={{ fontFamily: FONTS.body, fontSize: '13px', color: COLORS.textDim, fontStyle: 'italic' }}>
              No recorded activity yet
            </div>
          ) : (
            timeline.slice(-20).reverse().map(event => {
              const typeIcons: Record<string, string> = {
                conversation: '\u{1F4AC}',
                mood_change: '\u{1F3AD}',
                action: '\u{26A1}',
                board_post: '\u{1F4CB}',
                artifact: '\u{1F3A8}',
                death: '\u{1F480}',
              };
              return (
                <div
                  key={event.id}
                  style={{
                    padding: '6px 0',
                    borderBottom: '1px solid rgba(255,255,255,0.03)',
                    display: 'flex',
                    gap: 8,
                    alignItems: 'flex-start',
                  }}
                >
                  <span style={{ fontSize: '12px', flexShrink: 0, paddingTop: 1 }}>
                    {typeIcons[event.type] || '\u{2022}'}
                  </span>
                  <span style={{ fontFamily: FONTS.body, fontSize: '12px', color: COLORS.text, lineHeight: 1.4 }}>
                    {event.description.length > 120 ? event.description.substring(0, 117) + '...' : event.description}
                  </span>
                </div>
              );
            })
          )}
        </div>
      </div>

      <style>{`
        @keyframes slideInRight {
          from { transform: translateX(100%); }
          to { transform: translateX(0); }
        }
        @keyframes pulse {
          0%, 100% { opacity: 0.4; }
          50% { opacity: 0.7; }
        }
      `}</style>
    </div>
  );
};

const StatBar: React.FC<{ label: string; value: number; color: string; invert?: boolean }> = ({ label, value, color, invert }) => {
  const displayVal = invert ? 100 - value : value;
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
        <span style={{ fontFamily: FONTS.body, fontSize: '11px', color: COLORS.textDim }}>{label}</span>
        <span style={{ fontFamily: FONTS.body, fontSize: '11px', color: COLORS.text }}>{value}</span>
      </div>
      <div style={{ height: 4, background: COLORS.bgCard, borderRadius: 2, overflow: 'hidden' }}>
        <div style={{ width: `${displayVal}%`, height: '100%', background: color, borderRadius: 2 }} />
      </div>
    </div>
  );
};
