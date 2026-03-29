import React, { useRef, useEffect } from 'react';
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

function breathSpeed(state: string): number {
  switch (state) {
    case 'active': return 0.004;
    case 'routine': return 0.003;
    case 'idle': return 0.002;
    case 'sleeping': return 0.001;
    default: return 0.002;
  }
}

export const SocialNodeComponent: React.FC<SocialNodeProps> = ({
  id, name, mood, state, x, y, dimmed, selected, hovered, onMouseEnter, onMouseLeave, onClick,
}) => {
  const radius = 18;
  const moodRingColor = moodColor(mood);
  const baseOpacity = stateOpacity(state);
  const opacity = dimmed ? 0.15 : baseOpacity;
  const hoverScale = hovered ? 1.15 : 1;

  const gRef = useRef<SVGGElement>(null);
  const pos = useRef({ x, y });
  const targetPos = useRef({ x, y });
  const lerpStart = useRef(0);
  const lerpFrom = useRef({ x, y });
  const raf = useRef(0);

  // Update target when props change
  useEffect(() => {
    if (pos.current.x === 0 && pos.current.y === 0) {
      // First render — snap
      pos.current = { x, y };
      lerpFrom.current = { x, y };
    } else {
      lerpFrom.current = { x: pos.current.x, y: pos.current.y };
    }
    targetPos.current = { x, y };
    lerpStart.current = performance.now();
  }, [x, y]);

  // Continuous rAF loop: position lerp + breathing
  useEffect(() => {
    const speed = breathSpeed(state);
    const lerpDuration = 600;

    const animate = (now: number) => {
      // Position lerp
      const elapsed = now - lerpStart.current;
      const t = Math.min(1, elapsed / lerpDuration);
      const ease = 1 - Math.pow(1 - t, 3); // cubic ease-out

      const target = targetPos.current;
      const from = lerpFrom.current;
      const cx = from.x + (target.x - from.x) * ease;
      const cy = from.y + (target.y - from.y) * ease;
      pos.current = { x: cx, y: cy };

      // Breathing
      const breath = 1 + Math.sin(now * speed) * 0.02;
      const s = hoverScale * breath;

      if (gRef.current) {
        gRef.current.setAttribute('transform', `translate(${cx}, ${cy}) scale(${s})`);
      }

      raf.current = requestAnimationFrame(animate);
    };

    raf.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(raf.current);
  }, [state, hoverScale]);

  return (
    <g
      ref={gRef}
      transform={`translate(${x}, ${y}) scale(${hoverScale})`}
      style={{ cursor: 'pointer', opacity }}
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
