import React, { useState } from 'react';
import type { Agent } from '@ai-village/shared';
import { FONTS } from '../styles';
import { useTheme } from '../ThemeContext';

const CATEGORY_ICONS: Record<string, string> = {
  commitment: '🤝',
  need: '💡',
  threat: '⚠️',
  unresolved: '❓',
  goal: '🎯',
  rule: '⚖️',
};

const Section: React.FC<{
  title: string;
  count: number;
  defaultOpen?: boolean;
  children: React.ReactNode;
}> = ({ title, count, defaultOpen = false, children }) => {
  const { colors } = useTheme();
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ marginBottom: 12 }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          padding: 0,
          fontFamily: FONTS.pixel,
          fontSize: 7,
          color: colors.textDim,
          letterSpacing: 1,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        <span>{open ? '▾' : '▸'}</span>
        <span>{title}</span>
        <span style={{ fontSize: 6, color: colors.accent }}>({count})</span>
      </button>
      {open && <div style={{ marginTop: 6 }}>{children}</div>}
    </div>
  );
};

export const CognitionPanel: React.FC<{ agent: Agent }> = ({ agent }) => {
  const { colors } = useTheme();

  const concerns = agent.activeConcerns ?? [];
  const dossiers = agent.dossiers ?? [];
  const beliefs = agent.beliefs ?? [];
  const strategies = agent.learnedStrategies ?? [];
  const aversions = agent.learnedAversions ?? [];

  const itemStyle: React.CSSProperties = {
    fontFamily: FONTS.body,
    fontSize: 11,
    color: colors.text,
    backgroundColor: colors.bgCard,
    borderRadius: 4,
    padding: '6px 8px',
    marginBottom: 4,
    lineHeight: 1.5,
  };

  const dimStyle: React.CSSProperties = {
    fontSize: 10,
    color: colors.textDim,
  };

  return (
    <div style={{ padding: '8px 0' }}>
      <div style={{ fontFamily: FONTS.pixel, fontSize: 8, color: colors.accent, letterSpacing: 2, marginBottom: 10 }}>
        MIND
      </div>

      {/* World View */}
      {agent.worldView && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontFamily: FONTS.pixel, fontSize: 7, color: colors.textDim, letterSpacing: 1, marginBottom: 4 }}>
            WORLD VIEW
          </div>
          <div style={{ ...itemStyle, fontStyle: 'italic', color: colors.textDim }}>
            {agent.worldView.length > 300 ? agent.worldView.slice(0, 300) + '...' : agent.worldView}
          </div>
        </div>
      )}

      {/* Active Concerns */}
      <Section title="ACTIVE CONCERNS" count={concerns.length} defaultOpen={concerns.length > 0}>
        {concerns.length === 0 ? (
          <div style={dimStyle}>Nothing pressing on their mind.</div>
        ) : (
          concerns.filter(c => !c.resolved).map((c) => (
            <div key={c.id} style={itemStyle}>
              <span style={{ marginRight: 6 }}>{CATEGORY_ICONS[c.category] ?? '•'}</span>
              {c.content}
              <span style={{ ...dimStyle, marginLeft: 8 }}>{c.category}</span>
            </div>
          ))
        )}
      </Section>

      {/* Beliefs */}
      <Section title="BELIEFS" count={beliefs.length}>
        {beliefs.length === 0 ? (
          <div style={dimStyle}>No formed beliefs yet.</div>
        ) : (
          beliefs.slice(0, 15).map((b, i) => (
            <div key={i} style={itemStyle}>
              {b.content}
            </div>
          ))
        )}
      </Section>

      {/* Relationship Dossiers */}
      <Section title="DOSSIERS" count={dossiers.length}>
        {dossiers.length === 0 ? (
          <div style={dimStyle}>No relationship profiles yet.</div>
        ) : (
          dossiers.map((d) => (
            <div key={d.targetId} style={itemStyle}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                <span style={{ fontWeight: 'bold', color: colors.accent }}>{d.targetName}</span>
                <span style={{
                  fontSize: 10,
                  color: d.trust > 30 ? '#4ade80' : d.trust < -30 ? '#ef4444' : colors.textDim,
                }}>
                  Trust: {d.trust}
                </span>
              </div>
              <div style={{ fontSize: 11, color: colors.textDim }}>{d.summary}</div>
              {d.activeCommitments.length > 0 && (
                <div style={{ fontSize: 10, color: colors.gold, marginTop: 4 }}>
                  Commitments: {d.activeCommitments.join(', ')}
                </div>
              )}
            </div>
          ))
        )}
      </Section>

      {/* Learned Strategies */}
      <Section title="LEARNED STRATEGIES" count={strategies.length}>
        {strategies.length === 0 ? (
          <div style={dimStyle}>No strategies learned yet.</div>
        ) : (
          strategies.map((s, i) => (
            <div key={i} style={itemStyle}>
              <div>{s.content}</div>
              <div style={{ ...dimStyle, marginTop: 2 }}>
                Used {s.timesUsed}x · {s.timesSuccessful} successes · Avg reward: {s.avgRewardDelta.toFixed(2)}
              </div>
            </div>
          ))
        )}
      </Section>

      {/* Learned Aversions */}
      <Section title="LEARNED AVERSIONS" count={aversions.length}>
        {aversions.length === 0 ? (
          <div style={dimStyle}>No aversions or preferences formed.</div>
        ) : (
          aversions.map((a, i) => (
            <div key={i} style={itemStyle}>
              <span style={{ color: a.confidence < 0 ? '#ef4444' : '#4ade80' }}>
                {a.confidence < 0 ? '⛔' : '✅'} {a.actionType}
              </span>
              <span style={dimStyle}>
                {' '}— {Math.abs(a.confidence * 100).toFixed(0)}% {a.confidence < 0 ? 'aversion' : 'preference'} ({a.basis}, {a.evidenceCount} events)
              </span>
            </div>
          ))
        )}
      </Section>
    </div>
  );
};
