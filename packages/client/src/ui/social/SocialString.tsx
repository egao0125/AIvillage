import React from 'react';
import type { SocialEdge } from './types';

interface SocialStringProps {
  edge: SocialEdge;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  dimmed: boolean;
  hovered: boolean;
  sourceName: string;
  targetName: string;
  onClick: (edgeId: string) => void;
  onMouseEnter: (edgeId: string) => void;
  onMouseLeave: () => void;
}

function sentimentLabel(rep: number): string {
  if (rep > 20) return 'positive';
  if (rep < -20) return 'negative';
  return 'neutral';
}

export const SocialStringComponent: React.FC<SocialStringProps> = ({
  edge, x1, y1, x2, y2, dimmed, hovered, sourceName, targetName, onClick, onMouseEnter, onMouseLeave,
}) => {
  const opacity = dimmed ? 0.08 : hovered ? 1 : 0.6;

  // Bezier curve: slight arc for visual interest
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  // Perpendicular offset proportional to distance
  const offset = len * 0.1;
  const cx = mx + (-dy / len) * offset;
  const cy = my + (dx / len) * offset;
  const pathD = `M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`;

  // Determine animation
  let animationStyle: React.CSSProperties = {};
  if (edge.hasDisagreement) {
    animationStyle = { animation: 'socialFlicker 3s ease-in-out infinite' };
  } else if (edge.sharedEntries.some(e => e.sourceEntry.status === 'proposed' || e.sourceEntry.status === 'accepted')) {
    animationStyle = { animation: 'socialPulse 2s ease-in-out infinite' };
  } else {
    animationStyle = {
      strokeDasharray: '8 4',
      animation: 'socialBreathing 4s ease-in-out infinite',
    };
  }

  const tooltip = `${sourceName} \u2194 ${targetName}: ${edge.interactionCount} interaction${edge.interactionCount !== 1 ? 's' : ''}, ${sentimentLabel(edge.avgReputation)}${edge.hasDisagreement ? ' \u26a0 disagreement' : ''}`;

  return (
    <g style={{ transition: 'opacity 200ms ease', opacity, cursor: 'pointer' }}>
      <title>{tooltip}</title>
      {/* Invisible fat hit area */}
      <path
        d={pathD}
        fill="none"
        stroke="transparent"
        strokeWidth={Math.max(12, edge.thickness + 8)}
        onMouseEnter={() => onMouseEnter(edge.id)}
        onMouseLeave={onMouseLeave}
        onClick={() => onClick(edge.id)}
      />
      {/* Visible edge */}
      <path
        d={pathD}
        fill="none"
        stroke={edge.color}
        strokeWidth={edge.thickness}
        strokeLinecap="round"
        style={{ ...animationStyle, pointerEvents: 'none' }}
      />
      {/* Disagreement marker */}
      {edge.hasDisagreement && (
        <circle
          cx={cx}
          cy={cy}
          r={4}
          fill="#ff6b6b"
          style={{ animation: 'socialFlicker 3s ease-in-out infinite' }}
        />
      )}
    </g>
  );
};
