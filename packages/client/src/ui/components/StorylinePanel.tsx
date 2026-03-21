import React, { useState } from 'react';
import { useStorylines, useAgents } from '../../core/hooks';
import { nameToColor, hexToString } from '../../utils/color';
import { COLORS, FONTS } from '../styles';
import type { Storyline } from '@ai-village/shared';

const THEME_COLORS: Record<string, string> = {
  conflict: '#ef4444',
  romance: '#ec4899',
  power: '#f59e0b',
  alliance: '#4ade80',
  mystery: '#a855f7',
  survival: '#64748b',
};

const THEME_LABELS: Record<string, string> = {
  conflict: 'Conflict',
  romance: 'Romance',
  power: 'Power',
  alliance: 'Alliance',
  mystery: 'Mystery',
  survival: 'Survival',
};

export const StorylinePanel: React.FC = () => {
  const storylines = useStorylines();
  const agents = useAgents();
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Sort: active first, then by last updated
  const sorted = [...storylines].sort((a, b) => {
    const statusOrder: Record<string, number> = { climax: 0, developing: 1, dormant: 2, resolved: 3 };
    const aDiff = (statusOrder[a.status] ?? 4) - (statusOrder[b.status] ?? 4);
    if (aDiff !== 0) return aDiff;
    return b.lastUpdatedAt - a.lastUpdatedAt;
  });

  if (storylines.length === 0) {
    return (
      <div
        style={{
          padding: '40px 20px',
          textAlign: 'center',
          fontFamily: FONTS.body,
          color: COLORS.textDim,
          fontSize: '14px',
          fontStyle: 'italic',
        }}
      >
        No storylines detected yet. Stories emerge after agents interact for a day or more.
      </div>
    );
  }

  return (
    <div style={{ padding: '8px 0' }}>
      {sorted.map(storyline => (
        <StorylineCard
          key={storyline.id}
          storyline={storyline}
          agents={agents}
          expanded={expandedId === storyline.id}
          onToggle={() => setExpandedId(expandedId === storyline.id ? null : storyline.id)}
        />
      ))}
    </div>
  );
};

const StorylineCard: React.FC<{
  storyline: Storyline;
  agents: any[];
  expanded: boolean;
  onToggle: () => void;
}> = ({ storyline, agents, expanded, onToggle }) => {
  const themeColor = THEME_COLORS[storyline.theme] || '#666';
  const isDimmed = storyline.status === 'resolved' || storyline.status === 'dormant';

  return (
    <div
      style={{
        margin: '0 12px 8px',
        background: isDimmed ? 'rgba(255,255,255,0.02)' : COLORS.bgCard,
        borderRadius: 6,
        border: `1px solid ${isDimmed ? 'rgba(255,255,255,0.05)' : COLORS.border}`,
        overflow: 'hidden',
        opacity: isDimmed ? 0.6 : 1,
      }}
    >
      {/* Card header */}
      <div
        onClick={onToggle}
        style={{
          padding: '12px 14px',
          cursor: 'pointer',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          {/* Theme badge */}
          <span
            style={{
              fontFamily: FONTS.pixel,
              fontSize: '7px',
              color: themeColor,
              background: `${themeColor}20`,
              padding: '2px 6px',
              borderRadius: 8,
              textTransform: 'uppercase',
              letterSpacing: 0.5,
            }}
          >
            {THEME_LABELS[storyline.theme] || storyline.theme}
          </span>

          {/* Status badge */}
          <span
            style={{
              fontFamily: FONTS.pixel,
              fontSize: '7px',
              color: storyline.status === 'climax' ? '#ffd700' : COLORS.textDim,
              textTransform: 'uppercase',
              letterSpacing: 0.5,
            }}
          >
            {storyline.status === 'climax' ? '\u{1F525} CLIMAX' : storyline.status}
          </span>
        </div>

        {/* Title */}
        <div
          style={{
            fontFamily: FONTS.pixel,
            fontSize: '10px',
            color: COLORS.text,
            marginBottom: 6,
          }}
        >
          {storyline.title}
        </div>

        {/* Summary */}
        <div
          style={{
            fontFamily: FONTS.body,
            fontSize: '12px',
            color: COLORS.textDim,
            lineHeight: 1.4,
          }}
        >
          {storyline.summary}
        </div>

        {/* Involved agents */}
        <div style={{ display: 'flex', gap: 4, marginTop: 8, flexWrap: 'wrap' }}>
          {storyline.involvedAgentIds.map(id => {
            const agent = agents.find((a: any) => a.id === id);
            if (!agent) return null;
            const color = hexToString(nameToColor(agent.config.name));
            return (
              <span
                key={id}
                style={{
                  fontFamily: FONTS.body,
                  fontSize: '11px',
                  color,
                  fontWeight: 'bold',
                }}
              >
                {agent.config.name}
              </span>
            );
          })}
        </div>
      </div>

      {/* Expanded event timeline */}
      {expanded && storyline.events.length > 0 && (
        <div
          style={{
            borderTop: `1px solid ${COLORS.border}`,
            padding: '10px 14px',
            maxHeight: 200,
            overflowY: 'auto',
          }}
        >
          {storyline.events.slice(-15).reverse().map(event => (
            <div
              key={event.id}
              style={{
                padding: '5px 0',
                borderBottom: '1px solid rgba(255,255,255,0.03)',
                fontFamily: FONTS.body,
                fontSize: '11px',
                color: COLORS.textDim,
                lineHeight: 1.4,
              }}
            >
              <span style={{ color: '#666', marginRight: 6 }}>Day {event.day}</span>
              {event.description}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
