import React from 'react';
import { COLORS, FONTS } from '../styles';
import { moodColor, stateOpacity } from './socialAnimations';

interface SocialNodeProps {
  id: string;
  name: string;
  mood: string;
  state: string;
  x: number;
  y: number;
  dimmed: boolean;
  selected: boolean;
  hovered: boolean;
  onMouseEnter: (id: string) => void;
  onMouseLeave: () => void;
  onClick: (id: string) => void;
}

export const SocialNodeComponent: React.FC<SocialNodeProps> = ({
  id, name, mood, state, x, y, dimmed, selected, hovered, onMouseEnter, onMouseLeave, onClick,
}) => {
  const radius = 18;
  const moodRingColor = moodColor(mood);
  const baseOpacity = stateOpacity(state);
  const opacity = dimmed ? 0.15 : baseOpacity;
  const scale = hovered ? 1.15 : 1;

  return (
    <g
      transform={`translate(${x}, ${y}) scale(${scale})`}
      style={{ cursor: 'pointer', transition: 'transform 200ms ease, opacity 200ms ease', opacity }}
      onMouseEnter={() => onMouseEnter(id)}
      onMouseLeave={onMouseLeave}
      onClick={() => onClick(id)}
    >
      {/* Mood ring */}
      <circle
        r={radius + 3}
        fill="none"
        stroke={moodRingColor}
        strokeWidth={3}
        opacity={0.7}
      />
      {/* Selection ring */}
      {selected && (
        <circle
          r={radius + 7}
          fill="none"
          stroke={COLORS.accent}
          strokeWidth={2}
          strokeDasharray="4 2"
        />
      )}
      {/* Node body */}
      <circle
        r={radius}
        fill={COLORS.bgCard}
        stroke={COLORS.border}
        strokeWidth={1.5}
      />
      {/* Initial letter */}
      <text
        textAnchor="middle"
        dominantBaseline="central"
        fill={COLORS.textAccent}
        fontFamily={FONTS.pixel}
        fontSize="11px"
        style={{ pointerEvents: 'none', userSelect: 'none' }}
      >
        {name.charAt(0).toUpperCase()}
      </text>
      {/* Name label below */}
      <text
        y={radius + 14}
        textAnchor="middle"
        fill={COLORS.text}
        fontFamily={FONTS.body}
        fontSize="11px"
        style={{ pointerEvents: 'none', userSelect: 'none' }}
      >
        {name}
      </text>
    </g>
  );
};
