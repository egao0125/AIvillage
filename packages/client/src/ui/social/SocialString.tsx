import React, { useRef, useEffect } from 'react';
import type { SocialEdge } from './types';

/** Pulsing red glow along the edge path for disagreements */
const DisagreementGlow: React.FC<{ pathD: string; thickness: number }> = ({ pathD, thickness }) => {
  const glowRef = useRef<SVGPathElement>(null);

  useEffect(() => {
    const interval = setInterval(() => {
      if (!glowRef.current) return;
      const now = performance.now();
      const pulse = 0.2 + Math.sin(now * 0.003) * 0.12; // oscillates 0.08–0.32
      const width = thickness + 14 + Math.sin(now * 0.003) * 5; // oscillates ±5
      glowRef.current.setAttribute('opacity', `${pulse}`);
      glowRef.current.setAttribute('stroke-width', `${width}`);
    }, 66); // 15fps
    return () => clearInterval(interval);
  }, [thickness]);

  return (
    <path
      ref={glowRef}
      d={pathD}
      fill="none"
      stroke="#ff4444"
      strokeWidth={thickness + 14}
      strokeLinecap="round"
      opacity={0.2}
      style={{ pointerEvents: 'none' }}
    />
  );
};

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
  activeConversation: boolean;
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
  edge, x1, y1, x2, y2, dimmed, hovered, sourceName, targetName, activeConversation,
  onClick, onMouseEnter, onMouseLeave,
}) => {
  const baseOpacity = dimmed ? 0.08 : hovered ? 1 : 0.85;
  const convoBoost = activeConversation ? 0.15 : 0;
  const opacity = Math.min(1, baseOpacity + convoBoost);
  const strokeBoost = activeConversation ? 1.5 : 0;

  // Bezier curve
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const offset = len * 0.1;
  const cx = mx + (-dy / len) * offset;
  const cy = my + (dx / len) * offset;
  const pathD = `M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`;

  // Edge styling
  let edgeStyle: React.CSSProperties = {};
  if (edge.hasDisagreement) {
    edgeStyle = { strokeDasharray: '6 3' };
  } else if (!edge.sharedEntries.some(e => e.sourceEntry.status === 'proposed' || e.sourceEntry.status === 'accepted')) {
    edgeStyle = { strokeDasharray: '8 4' };
  }

  const tooltip = `${sourceName} \u2194 ${targetName}: ${edge.interactionCount} interaction${edge.interactionCount !== 1 ? 's' : ''}, ${sentimentLabel(edge.avgReputation)}${edge.hasDisagreement ? ' \u26a0 disagreement' : ''}`;

  // Conversation pulse: traveling dot along bezier
  const dotRef = useRef<SVGCircleElement>(null);
  const rafRef = useRef(0);

  useEffect(() => {
    if (!activeConversation) {
      if (dotRef.current) dotRef.current.setAttribute('opacity', '0');
      cancelAnimationFrame(rafRef.current);
      return;
    }

    const animate = (now: number) => {
      if (!dotRef.current) return;
      // Oscillate t between 0 and 1
      const period = 2000; // ms for full round trip
      const raw = (now % period) / period;
      const t = raw < 0.5 ? raw * 2 : 2 - raw * 2; // ping-pong

      const u = 1 - t;
      const px = u * u * x1 + 2 * u * t * cx + t * t * x2;
      const py = u * u * y1 + 2 * u * t * cy + t * t * y2;

      dotRef.current.setAttribute('cx', `${px}`);
      dotRef.current.setAttribute('cy', `${py}`);
      dotRef.current.setAttribute('opacity', '0.85');

      rafRef.current = requestAnimationFrame(animate);
    };

    rafRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(rafRef.current);
  }, [activeConversation, x1, y1, x2, y2, cx, cy]);

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
      {/* Glow layer — wide soft stroke, no filter */}
      <path
        d={pathD}
        fill="none"
        stroke={activeConversation ? '#64ffda' : edge.color}
        strokeWidth={edge.thickness + 6}
        strokeLinecap="round"
        opacity={activeConversation ? 0.25 : 0.12}
        style={{ pointerEvents: 'none' }}
      />
      {/* Active conversation extra glow */}
      {activeConversation && (
        <path
          d={pathD}
          fill="none"
          stroke="#64ffda"
          strokeWidth={edge.thickness + strokeBoost + 10}
          strokeLinecap="round"
          opacity={0.06}
          style={{ pointerEvents: 'none' }}
        />
      )}
      {/* Visible edge */}
      <path
        d={pathD}
        fill="none"
        stroke={activeConversation ? '#64ffda' : edge.color}
        strokeWidth={edge.thickness + strokeBoost}
        strokeLinecap="round"
        style={{ ...edgeStyle, pointerEvents: 'none' }}
      />
      {/* Disagreement glow pulse — red halo that breathes */}
      {edge.hasDisagreement && (
        <DisagreementGlow pathD={pathD} thickness={edge.thickness} />
      )}
      {/* Conversation traveling dot */}
      <circle
        ref={dotRef}
        r={4}
        fill="#fbbf24"
        opacity={0}
        style={{ pointerEvents: 'none' }}
      />
    </g>
  );
};
