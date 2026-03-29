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

/**
 * Each node smoothly interpolates to its target position via rAF lerp.
 * This avoids CSS transition jank on SVG transforms and gives 60fps movement.
 */
export const SocialNodeComponent: React.FC<SocialNodeProps> = ({
  id, name, mood, state, x, y, dimmed, selected, hovered, onMouseEnter, onMouseLeave, onClick,
}) => {
  const radius = 18;
  const moodRingColor = moodColor(mood);
  const baseOpacity = stateOpacity(state);
  const opacity = dimmed ? 0.15 : baseOpacity;
  const scale = hovered ? 1.15 : 1;

  const gRef = useRef<SVGGElement>(null);
  const pos = useRef({ x, y });
  const raf = useRef(0);

  useEffect(() => {
    const target = { x, y };
    const duration = 600; // ms
    const start = performance.now();
    const from = { x: pos.current.x, y: pos.current.y };

    // Skip animation if first render (no meaningful "from")
    if (from.x === 0 && from.y === 0) {
      pos.current = target;
      if (gRef.current) {
        gRef.current.setAttribute('transform', `translate(${x}, ${y}) scale(${scale})`);
      }
      return;
    }

    cancelAnimationFrame(raf.current);

    const animate = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      // Smooth ease-out cubic
      const ease = 1 - Math.pow(1 - t, 3);

      const cx = from.x + (target.x - from.x) * ease;
      const cy = from.y + (target.y - from.y) * ease;
      pos.current = { x: cx, y: cy };

      if (gRef.current) {
        gRef.current.setAttribute('transform', `translate(${cx}, ${cy}) scale(${scale})`);
      }

      if (t < 1) {
        raf.current = requestAnimationFrame(animate);
      } else {
        pos.current = target;
      }
    };

    raf.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(raf.current);
  }, [x, y, scale]);

  return (
    <g
      ref={gRef}
      transform={`translate(${x}, ${y}) scale(${scale})`}
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
