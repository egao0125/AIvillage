import { useRef, useState, useEffect } from 'react';

interface SpringConfig {
  stiffness?: number;
  damping?: number;
  precision?: number;
}

/**
 * Lightweight spring interpolation using rAF.
 * Returns the current animated value, given a target.
 */
export function useSpring(
  target: number,
  config: SpringConfig = {},
): number {
  const { stiffness = 170, damping = 26, precision = 0.01 } = config;
  const [value, setValue] = useState(target);
  const ref = useRef({ value: target, velocity: 0 });
  const rafRef = useRef<number>(0);

  useEffect(() => {
    const state = ref.current;

    const step = () => {
      const displacement = state.value - target;
      const springForce = -stiffness * displacement;
      const dampingForce = -damping * state.velocity;
      const acceleration = springForce + dampingForce;

      state.velocity += acceleration * (1 / 60);
      state.value += state.velocity * (1 / 60);

      if (Math.abs(displacement) < precision && Math.abs(state.velocity) < precision) {
        state.value = target;
        state.velocity = 0;
        setValue(target);
        return;
      }

      setValue(state.value);
      rafRef.current = requestAnimationFrame(step);
    };

    rafRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafRef.current);
  }, [target, stiffness, damping, precision]);

  return value;
}

/**
 * Spring-interpolate between two sets of node positions.
 * Returns interpolated { x, y } for each node ID.
 */
export function useSpringPositions(
  targets: Map<string, { x: number; y: number }>,
  config: SpringConfig = {},
): Map<string, { x: number; y: number }> {
  const { stiffness = 170, damping = 26, precision = 0.5 } = config;
  const stateRef = useRef<Map<string, { x: number; y: number; vx: number; vy: number }>>(new Map());
  const [positions, setPositions] = useState<Map<string, { x: number; y: number }>>(targets);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    const state = stateRef.current;

    // Initialize new nodes
    for (const [id, target] of targets) {
      if (!state.has(id)) {
        state.set(id, { x: target.x, y: target.y, vx: 0, vy: 0 });
      }
    }

    let settled = false;

    const step = () => {
      settled = true;
      const result = new Map<string, { x: number; y: number }>();

      for (const [id, target] of targets) {
        const s = state.get(id)!;
        const dx = s.x - target.x;
        const dy = s.y - target.y;

        const ax = -stiffness * dx - damping * s.vx;
        const ay = -stiffness * dy - damping * s.vy;

        s.vx += ax * (1 / 60);
        s.vy += ay * (1 / 60);
        s.x += s.vx * (1 / 60);
        s.y += s.vy * (1 / 60);

        if (Math.abs(dx) > precision || Math.abs(dy) > precision ||
            Math.abs(s.vx) > precision || Math.abs(s.vy) > precision) {
          settled = false;
        } else {
          s.x = target.x;
          s.y = target.y;
          s.vx = 0;
          s.vy = 0;
        }

        result.set(id, { x: s.x, y: s.y });
      }

      setPositions(result);

      if (!settled) {
        rafRef.current = requestAnimationFrame(step);
      }
    };

    rafRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafRef.current);
  }, [targets, stiffness, damping, precision]);

  return positions;
}
