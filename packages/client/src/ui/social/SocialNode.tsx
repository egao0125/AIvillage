import React, { useRef, useEffect } from 'react';
import { COLORS } from '../styles';
import { moodColor, stateOpacity } from './socialAnimations';

interface SocialNodeProps {
  id: string;
  name: string;
  mood: string;
  state: string;
  x: number;
  y: number;
  connectionCount: number;
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
  id, name, mood, state, x, y, connectionCount, dimmed, selected, hovered,
  onMouseEnter, onMouseLeave, onClick,
}) => {
  // Scale node size by connectivity (min 18, max 28)
  const radius = Math.min(28, 18 + connectionCount * 1.5);
  const moodRingColor = moodColor(mood);
  const baseOpacity = stateOpacity(state);
  const opacity = dimmed ? 0.12 : baseOpacity;
  const hoverScale = hovered ? 1.12 : 1;

  const gRef = useRef<SVGGElement>(null);
  const pos = useRef({ x, y });
  const targetPos = useRef({ x, y });
  const lerpStart = useRef(0);
  const lerpFrom = useRef({ x, y });
  const raf = useRef(0);

  useEffect(() => {
    if (pos.current.x === 0 && pos.current.y === 0) {
      pos.current = { x, y };
      lerpFrom.current = { x, y };
    } else {
      lerpFrom.current = { x: pos.current.x, y: pos.current.y };
    }
    targetPos.current = { x, y };
    lerpStart.current = performance.now();
  }, [x, y]);

  // Position lerp (runs only during transition, then stops)
  useEffect(() => {
    const lerpDuration = 600;

    const animate = (now: number) => {
      const elapsed = now - lerpStart.current;
      const t = Math.min(1, elapsed / lerpDuration);
      const ease = 1 - Math.pow(1 - t, 3);

      const target = targetPos.current;
      const from = lerpFrom.current;
      const cx = from.x + (target.x - from.x) * ease;
      const cy = from.y + (target.y - from.y) * ease;
      pos.current = { x: cx, y: cy };

      if (gRef.current) {
        gRef.current.setAttribute('transform', `translate(${cx}, ${cy}) scale(${hoverScale})`);
      }

      if (t < 1) {
        raf.current = requestAnimationFrame(animate);
      }
    };

    raf.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(raf.current);
  }, [x, y, hoverScale]);

  // Breathing: low-frequency interval (15fps) instead of rAF per node
  useEffect(() => {
    const speed = breathSpeed(state);
    const interval = setInterval(() => {
      if (!gRef.current) return;
      const now = performance.now();
      const breath = 1 + Math.sin(now * speed) * 0.02;
      const s = hoverScale * breath;
      const p = pos.current;
      gRef.current.setAttribute('transform', `translate(${p.x}, ${p.y}) scale(${s})`);
    }, 66); // ~15fps — plenty smooth for 2% oscillation

    return () => clearInterval(interval);
  }, [state, hoverScale]);

  // First letter + last initial for label
  const parts = name.split(' ');
  const initials = parts.length > 1
    ? parts[0][0] + parts[parts.length - 1][0]
    : name.slice(0, 2);

  return (
    <g
      ref={gRef}
      transform={`translate(${x}, ${y}) scale(${hoverScale})`}
      style={{ cursor: 'pointer', opacity }}
      onMouseEnter={() => onMouseEnter(id)}
      onMouseLeave={onMouseLeave}
      onClick={() => onClick(id)}
    >
      {/* Outer glow halo — faked with wide soft stroke, no filter */}
      <circle
        r={radius + 6}
        fill="none"
        stroke={moodRingColor}
        strokeWidth={6}
        opacity={0.08}
      />
      <circle
        r={radius + 4}
        fill="none"
        stroke={moodRingColor}
        strokeWidth={4}
        opacity={0.15}
      />
      {/* Mood ring */}
      <circle
        r={radius + 2}
        fill="none"
        stroke={moodRingColor}
        strokeWidth={2}
        opacity={0.85}
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
      {/* Node body — gradient fill for depth */}
      <circle
        r={radius}
        fill="url(#node-gradient)"
        stroke="rgba(100,255,218,0.15)"
        strokeWidth={1}
      />
      {/* Inner highlight for 3D effect */}
      <circle
        r={radius * 0.6}
        fill="none"
        stroke="rgba(255,255,255,0.04)"
        strokeWidth={radius * 0.3}
      />
      {/* Initials */}
      <text
        textAnchor="middle"
        dominantBaseline="central"
        fill={COLORS.textAccent}
        fontFamily="'Press Start 2P', monospace"
        fontSize={radius > 22 ? '8px' : '7px'}
        letterSpacing="0.5"
        style={{ pointerEvents: 'none', userSelect: 'none' }}
      >
        {initials.toUpperCase()}
      </text>
      {/* Name label below */}
      <text
        y={radius + 16}
        textAnchor="middle"
        fill={COLORS.text}
        fontFamily="'Press Start 2P', monospace"
        fontSize="7px"
        opacity={0.8}
        style={{ pointerEvents: 'none', userSelect: 'none' }}
      >
        {name}
      </text>
    </g>
  );
};
