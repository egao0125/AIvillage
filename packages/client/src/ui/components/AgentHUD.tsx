import React, { useState } from 'react';
import { useFocusedAgent } from '../../core/hooks';
import type { Item } from '@ai-village/shared';

const MOOD_KEYWORDS: [string, string][] = [
  ['happy', '#fbbf24'],
  ['content', '#4ade80'],
  ['excited', '#f97316'],
  ['angry', '#ef4444'],
  ['frustrat', '#ef4444'],
  ['sad', '#60a5fa'],
  ['anxious', '#a78bfa'],
  ['nervous', '#a78bfa'],
  ['unsettle', '#a78bfa'],
  ['scheming', '#ec4899'],
  ['afraid', '#6b7280'],
  ['fear', '#6b7280'],
];

function moodToColor(mood: string): string {
  const lower = mood.toLowerCase();
  for (const [keyword, color] of MOOD_KEYWORDS) {
    if (lower.includes(keyword)) return color;
  }
  return '#6b7280';
}

const StatBar: React.FC<{ label: string; value: number; color: string }> = ({ label, value, color }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
    <span style={{
      fontSize: 9,
      fontFamily: '"Press Start 2P", monospace',
      color: '#8888a8',
      width: 28,
      flexShrink: 0,
    }}>
      {label}
    </span>
    <div style={{
      flex: 1,
      height: 4,
      borderRadius: 2,
      background: 'rgba(255,255,255,0.08)',
      overflow: 'hidden',
    }}>
      <div style={{
        width: `${Math.max(0, Math.min(100, value))}%`,
        height: '100%',
        borderRadius: 2,
        background: color,
        transition: 'width 0.3s ease',
      }} />
    </div>
    <span style={{
      fontSize: 10,
      fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, sans-serif',
      color: '#8888a8',
      width: 22,
      textAlign: 'right',
      flexShrink: 0,
    }}>
      {Math.round(value)}
    </span>
  </div>
);

function groupItems(items: Item[]): { name: string; count: number }[] {
  const map = new Map<string, number>();
  for (const item of items) {
    map.set(item.name, (map.get(item.name) || 0) + 1);
  }
  return Array.from(map, ([name, count]) => ({ name, count }));
}

interface AgentHUDProps {
  onHistoryToggle?: () => void;
}

export const AgentHUD: React.FC<AgentHUDProps> = ({ onHistoryToggle }) => {
  const { agent } = useFocusedAgent();
  const [historyHover, setHistoryHover] = useState(false);

  const hasAgent = !!agent;
  const vitals = agent?.vitals;
  const mood = agent?.mood || 'neutral';
  const moodColor = moodToColor(mood);
  const inventory = agent?.inventory || [];
  const grouped = groupItems(inventory);

  return (
    <div style={{
      position: 'absolute',
      bottom: 64,
      left: 16,
      width: 220,
      padding: 14,
      background: 'rgba(22, 22, 37, 0.85)',
      backdropFilter: 'blur(12px)',
      border: '1px solid rgba(100, 255, 218, 0.08)',
      borderRadius: 10,
      zIndex: 50,
      pointerEvents: hasAgent ? 'auto' : 'none',
      opacity: hasAgent ? 1 : 0,
      transition: 'opacity 0.2s',
    }}>
      {agent && (
        <>
          {/* Death banner */}
          {agent.alive === false && (
            <div style={{
              fontSize: 10,
              fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, sans-serif',
              color: '#ef4444',
              background: 'rgba(239, 68, 68, 0.1)',
              border: '1px solid rgba(239, 68, 68, 0.2)',
              borderRadius: 4,
              padding: '3px 8px',
              marginBottom: 6,
            }}>
              DEAD{agent.causeOfDeath ? ` — ${agent.causeOfDeath}` : ''}
            </div>
          )}

          {/* Name */}
          <div style={{
            fontSize: 14,
            fontWeight: 600,
            fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, sans-serif',
            color: agent.alive === false ? '#666666' : '#e8e8f0',
            marginBottom: 2,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}>
            {agent.config.name}
          </div>

          {/* Mood — 2-line max with colored left accent */}
          <div style={{
            display: 'flex',
            gap: 6,
            fontSize: 10,
            fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, sans-serif',
            color: '#9999b0',
            marginBottom: 6,
            lineHeight: 1.4,
          }}>
            <span style={{
              width: 3,
              minHeight: 14,
              borderRadius: 2,
              background: moodColor,
              flexShrink: 0,
              alignSelf: 'stretch',
            }} />
            <span style={{
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            } as React.CSSProperties}>
              {mood}
            </span>
          </div>

          {/* Current action */}
          <div style={{
            fontSize: 11,
            fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, sans-serif',
            color: '#555570',
            fontStyle: 'italic',
            marginBottom: vitals ? 10 : 8,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}>
            {agent.currentAction || 'Idle'}
          </div>

          {/* Vitals bars — hide in werewolf mode (no hunger system) */}
          {vitals && agent.mapId !== 'werewolf' && (
            <div style={{ marginBottom: 8 }}>
              <StatBar label="HP" value={vitals.health} color="#4ade80" />
              <StatBar label="NRG" value={vitals.energy} color="#60a5fa" />
              <StatBar label="HNG" value={vitals.hunger} color="#f97316" />
            </div>
          )}

          {/* Currency — hide in werewolf mode */}
          {agent.mapId !== 'werewolf' && (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              fontSize: 11,
              fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, sans-serif',
              color: '#fbbf24',
              marginBottom: 6,
            }}>
              <span>🪙</span>
              <span>{agent.currency ?? 0}</span>
            </div>
          )}

          {/* Inventory — flowing tags, 2 rows max */}
          <div style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 3,
            marginBottom: 8,
            maxHeight: 34,
            overflow: 'hidden',
          }}>
            {grouped.length === 0 ? (
              <span style={{
                fontSize: 9,
                fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, sans-serif',
                color: '#555570',
              }}>
                Empty inventory
              </span>
            ) : (
              grouped.map(({ name, count }) => (
                <span key={name} style={{
                  fontSize: 9,
                  fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, sans-serif',
                  color: '#9999b0',
                  background: 'rgba(255,255,255,0.05)',
                  borderRadius: 3,
                  padding: '2px 5px',
                  whiteSpace: 'nowrap',
                }}>
                  {name}{count > 1 ? ` x${count}` : ''}
                </span>
              ))
            )}
          </div>

          {/* History button */}
          {onHistoryToggle && (
            <button
              onClick={onHistoryToggle}
              onMouseEnter={() => setHistoryHover(true)}
              onMouseLeave={() => setHistoryHover(false)}
              style={{
                background: 'none',
                border: 'none',
                padding: 0,
                cursor: 'pointer',
                fontSize: 10,
                fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, sans-serif',
                color: historyHover ? '#64ffda' : '#8888a8',
                transition: 'color 0.15s',
              }}
            >
              History ▸
            </button>
          )}
        </>
      )}
    </div>
  );
};
