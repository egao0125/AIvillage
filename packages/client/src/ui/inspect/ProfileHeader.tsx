import React from 'react';
import type { Agent } from '@ai-village/shared';
import { FONTS } from '../styles';
import { useTheme } from '../ThemeContext';
import { nameToColor, hexToString } from '../../utils/color';

const MOOD_COLORS: Record<string, string> = {
  content: '#4ade80',
  happy: '#fbbf24',
  angry: '#ef4444',
  sad: '#60a5fa',
  anxious: '#a78bfa',
  excited: '#f97316',
  scheming: '#ec4899',
  afraid: '#6b7280',
};

export const ProfileHeader: React.FC<{ agent: Agent }> = ({ agent }) => {
  const { colors } = useTheme();
  const isDead = agent.alive === false;
  const avatarColor = hexToString(nameToColor(agent.config.name));
  const moodColor = MOOD_COLORS[agent.mood] ?? colors.textDim;

  return (
    <div style={{ opacity: isDead ? 0.5 : 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: '16px 0' }}>
      {/* Avatar */}
      <div style={{
        width: 72,
        height: 72,
        borderRadius: '50%',
        backgroundColor: avatarColor,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#ffffff',
        fontWeight: 'bold',
        fontSize: 28,
        fontFamily: FONTS.body,
      }}>
        {agent.config.name.charAt(0)}
      </div>

      {/* Name */}
      <div style={{ fontFamily: FONTS.pixel, fontSize: 14, color: colors.text }}>
        {agent.config.name}
      </div>

      {/* Occupation */}
      {agent.config.occupation && (
        <div style={{ fontFamily: FONTS.body, fontSize: 12, color: colors.textDim }}>
          {agent.config.occupation}
        </div>
      )}

      {/* Age */}
      {agent.config.age != null && (
        <div style={{ fontFamily: FONTS.body, fontSize: 11, color: colors.textDim }}>
          Age {agent.config.age}
        </div>
      )}

      {/* Mood badge */}
      <div style={{
        display: 'inline-block',
        padding: '3px 10px',
        borderRadius: 12,
        backgroundColor: moodColor + '22',
        border: `1px solid ${moodColor}44`,
        color: moodColor,
        fontFamily: FONTS.body,
        fontSize: 11,
        textTransform: 'capitalize',
      }}>
        {agent.mood}
      </div>

      {/* Current action */}
      {agent.currentAction && (
        <div style={{ fontFamily: FONTS.body, fontSize: 12, color: colors.textDim, fontStyle: 'italic', textAlign: 'center' }}>
          {agent.currentAction}
        </div>
      )}

      {/* Death notice */}
      {isDead && (
        <div style={{ fontFamily: FONTS.body, fontSize: 12, color: colors.warning }}>
          {'💀'} {agent.causeOfDeath ?? 'Deceased'}
        </div>
      )}
    </div>
  );
};
