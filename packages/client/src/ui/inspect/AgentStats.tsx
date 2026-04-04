import React from 'react';
import type { Agent } from '@ai-village/shared';
import { FONTS } from '../styles';
import { useTheme } from '../ThemeContext';

export const AgentStats: React.FC<{ agent: Agent }> = ({ agent }) => {
  const { colors } = useTheme();

  const StatBar: React.FC<{ label: string; value: number; max: number; color: string }> = ({ label, value, max, color }) => (
    <div style={{ marginBottom: 6 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: FONTS.body, fontSize: 11, color: colors.textDim, marginBottom: 2 }}>
        <span>{label}</span>
        <span>{Math.round(value)}/{max}</span>
      </div>
      <div style={{ height: 6, backgroundColor: colors.border, borderRadius: 3, overflow: 'hidden' }}>
        <div style={{
          width: `${(value / max) * 100}%`,
          height: '100%',
          backgroundColor: color,
          borderRadius: 3,
          transition: 'width 0.3s ease',
        }} />
      </div>
    </div>
  );
  return (
    <div style={{ padding: '8px 0' }}>
      <div style={{ fontFamily: FONTS.pixel, fontSize: 8, color: colors.textDim, letterSpacing: 2, marginBottom: 8 }}>
        STATS
      </div>

      {/* Vitals */}
      <StatBar label="Health" value={agent.vitals?.health ?? 100} max={100} color="#4ade80" />
      <StatBar label="Energy" value={agent.vitals?.energy ?? 100} max={100} color="#60a5fa" />
      <StatBar label="Hunger" value={agent.vitals?.hunger ?? 0} max={100} color="#f97316" />

      {/* Currency */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '10px 0', fontFamily: FONTS.body, fontSize: 12, color: colors.gold }}>
        <span>{'🪙'}</span>
        <span>{agent.currency}</span>
      </div>

      {/* Inventory */}
      <div style={{ fontFamily: FONTS.body, fontSize: 11, color: colors.textDim, marginBottom: 4 }}>Inventory</div>
      {agent.inventory.length === 0 ? (
        <div style={{ fontFamily: FONTS.body, fontSize: 11, color: colors.textDim, fontStyle: 'italic', marginBottom: 8 }}>Empty</div>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
          {Object.entries(
            agent.inventory.reduce<Record<string, number>>((acc, item) => {
              acc[item.name] = (acc[item.name] || 0) + 1;
              return acc;
            }, {})
          ).map(([name, count]) => (
            <span key={name} style={{
              fontFamily: FONTS.body,
              fontSize: 11,
              color: colors.text,
              backgroundColor: colors.bgCard,
              padding: '2px 6px',
              borderRadius: 3,
            }}>
              {name}{count > 1 ? ` x${count}` : ''}
            </span>
          ))}
        </div>
      )}

      {/* Skills */}
      <div style={{ fontFamily: FONTS.body, fontSize: 11, color: colors.textDim, marginBottom: 4 }}>Skills</div>
      {agent.skills.length === 0 ? (
        <div style={{ fontFamily: FONTS.body, fontSize: 11, color: colors.textDim, fontStyle: 'italic' }}>None</div>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {agent.skills.map((skill) => (
            <span key={skill.name} style={{
              fontFamily: FONTS.body,
              fontSize: 11,
              color: colors.text,
              backgroundColor: colors.bgCard,
              padding: '2px 6px',
              borderRadius: 3,
            }}>
              {skill.name} Lv.{skill.level}
            </span>
          ))}
        </div>
      )}
    </div>
  );
};
