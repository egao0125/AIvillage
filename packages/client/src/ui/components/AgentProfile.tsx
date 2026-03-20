import React from 'react';
import type { Agent, Item, Skill } from '@ai-village/shared';
import { nameToColor, hexToString } from '../../utils/color';
import { useReputation } from '../../core/hooks';
import { COLORS, FONTS } from '../styles';

const MOOD_DISPLAY: Record<string, { emoji: string; label: string; color: string }> = {
  neutral: { emoji: '\u{1F610}', label: 'Neutral', color: '#9ca3af' },
  happy: { emoji: '\u{1F60A}', label: 'Happy', color: '#4ade80' },
  angry: { emoji: '\u{1F620}', label: 'Angry', color: '#ef4444' },
  sad: { emoji: '\u{1F622}', label: 'Sad', color: '#60a5fa' },
  anxious: { emoji: '\u{1F630}', label: 'Anxious', color: '#fbbf24' },
  excited: { emoji: '\u{1F929}', label: 'Excited', color: '#f97316' },
  scheming: { emoji: '\u{1F914}', label: 'Scheming', color: '#a855f7' },
  afraid: { emoji: '\u{1F628}', label: 'Afraid', color: '#94a3b8' },
};

const ITEM_TYPE_COLORS: Record<string, string> = {
  tool: '#60a5fa',
  food: '#4ade80',
  material: '#a78bfa',
  art: '#f97316',
  medicine: '#ef4444',
  document: '#fbbf24',
  gift: '#ec4899',
  other: '#9ca3af',
};

const sectionLabel: React.CSSProperties = {
  color: COLORS.textAccent,
  marginBottom: 6,
  fontSize: '9px',
  fontFamily: FONTS.pixel,
  textTransform: 'uppercase' as const,
  letterSpacing: 1,
};

interface AgentProfileProps {
  agent: Agent;
  onClose: () => void;
}

export const AgentProfile: React.FC<AgentProfileProps> = ({
  agent,
  onClose,
}) => {
  const color = hexToString(nameToColor(agent.config.name));
  const reputation = useReputation();
  const agentReputation = reputation.filter((r) => r.fromAgentId === agent.id);

  const moodInfo = MOOD_DISPLAY[agent.mood] || MOOD_DISPLAY.neutral;

  return (
    <div
      style={{
        padding: 16,
        fontFamily: FONTS.body,
        fontSize: '13px',
        color: COLORS.text,
        borderBottom: `1px solid ${COLORS.border}`,
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          marginBottom: 14,
        }}
      >
        <div
          style={{
            width: 48,
            height: 48,
            borderRadius: '50%',
            background: color,
            border: `2px solid ${COLORS.accent}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '18px',
            flexShrink: 0,
          }}
        >
          {agent.config.name[0]}
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: '11px', marginBottom: 4, fontFamily: FONTS.pixel }}>
            {agent.config.name}
          </div>
          <div style={{ color: COLORS.textDim, fontSize: '13px' }}>
            {agent.config.occupation}, {agent.config.age}
          </div>
        </div>
        <button
          onClick={onClose}
          style={{
            background: 'none',
            border: 'none',
            color: COLORS.textDim,
            cursor: 'pointer',
            fontSize: '14px',
            fontFamily: FONTS.body,
          }}
        >
          {'\u2715'}
        </button>
      </div>

      {/* Currency + Mood row */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 12px',
            background: COLORS.bgCard,
            borderRadius: 4,
            border: `1px solid ${COLORS.border}`,
          }}
        >
          <span style={{ fontSize: '16px' }}>{'\u{1FA99}'}</span>
          <div>
            <div style={{ color: COLORS.gold, fontSize: '13px', fontWeight: 'bold' }}>
              {agent.currency ?? 0} Gold
            </div>
          </div>
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '8px 12px',
            background: COLORS.bgCard,
            borderRadius: 4,
            border: `1px solid ${COLORS.border}`,
          }}
        >
          <span style={{ fontSize: '16px' }}>{moodInfo.emoji}</span>
          <span style={{ color: moodInfo.color, fontSize: '13px' }}>
            {moodInfo.label}
          </span>
        </div>
      </div>

      {/* Soul */}
      {agent.config.soul && (
        <div style={{ marginBottom: 14 }}>
          <div style={sectionLabel}>SOUL</div>
          <div style={{ color: COLORS.textDim, lineHeight: '1.6', fontSize: '12px' }}>
            {agent.config.soul}
          </div>
        </div>
      )}

      {/* Current state */}
      <div style={{ marginBottom: 14 }}>
        <div style={sectionLabel}>STATUS</div>
        <div style={{ color: COLORS.textDim, fontSize: '13px' }}>
          {agent.currentAction || agent.state}
        </div>
      </div>

      {/* Inventory */}
      {agent.inventory && agent.inventory.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div style={sectionLabel}>INVENTORY ({agent.inventory.length})</div>
          {agent.inventory.map((item: Item) => (
            <div
              key={item.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '6px 10px',
                marginBottom: 3,
                background: COLORS.bgCard,
                borderRadius: 4,
                border: `1px solid ${COLORS.border}`,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ color: COLORS.text, fontSize: '12px' }}>{item.name}</span>
                <span
                  style={{
                    fontSize: '9px',
                    padding: '2px 6px',
                    borderRadius: 3,
                    background: ITEM_TYPE_COLORS[item.type] || ITEM_TYPE_COLORS.other,
                    color: '#000',
                    fontWeight: 'bold',
                  }}
                >
                  {item.type.toUpperCase()}
                </span>
              </div>
              <span style={{ color: COLORS.gold, fontSize: '12px' }}>
                {item.value}g
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Skills */}
      {agent.skills && agent.skills.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div style={sectionLabel}>SKILLS</div>
          {agent.skills.map((skill: Skill) => (
            <div
              key={skill.name}
              style={{
                padding: '6px 10px',
                marginBottom: 3,
                background: COLORS.bgCard,
                borderRadius: 4,
                border: `1px solid ${COLORS.border}`,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  marginBottom: 4,
                }}
              >
                <span style={{ color: COLORS.text, fontSize: '12px' }}>{skill.name}</span>
                <span style={{ color: COLORS.textDim, fontSize: '12px' }}>
                  Lv.{skill.level}
                </span>
              </div>
              <div
                style={{
                  width: '100%',
                  height: 6,
                  background: COLORS.border,
                  borderRadius: 3,
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    width: `${Math.min(skill.level * 10, 100)}%`,
                    height: '100%',
                    background: COLORS.accent,
                    borderRadius: 3,
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Reputation */}
      {agentReputation.length > 0 && (
        <div>
          <div style={sectionLabel}>REPUTATION</div>
          {agentReputation.map((rep) => (
            <div
              key={`${rep.fromAgentId}-${rep.toAgentId}`}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                padding: '6px 10px',
                marginBottom: 3,
                background: COLORS.bgCard,
                borderRadius: 4,
                border: `1px solid ${COLORS.border}`,
              }}
            >
              <span style={{ color: COLORS.text, fontSize: '12px' }}>{rep.toAgentId}</span>
              <span
                style={{
                  color:
                    rep.score > 0
                      ? COLORS.active
                      : rep.score < 0
                      ? COLORS.warning
                      : COLORS.textDim,
                  fontSize: '12px',
                  fontWeight: 'bold',
                }}
              >
                {rep.score > 0 ? '+' : ''}
                {rep.score}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
