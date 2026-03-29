import { useEffect, useRef, useCallback } from 'react';
import { eventBus } from '../../core/EventBus';
import type { SocialLedgerEntry } from '@ai-village/shared';
import type { SocialNode } from './types';

const SVG_NS = 'http://www.w3.org/2000/svg';
const MAX_PARTICLES = 20;

/** Quadratic bezier point at t */
function bezierPoint(
  x0: number, y0: number,
  cx: number, cy: number,
  x1: number, y1: number,
  t: number,
): { x: number; y: number } {
  const u = 1 - t;
  return {
    x: u * u * x0 + 2 * u * t * cx + t * t * x1,
    y: u * u * y0 + 2 * u * t * cy + t * t * y1,
  };
}

/** Compute bezier control point for an edge (same math as SocialString) */
function controlPoint(x1: number, y1: number, x2: number, y2: number) {
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const offset = len * 0.1;
  return { cx: mx + (-dy / len) * offset, cy: my + (dx / len) * offset };
}

interface Particle {
  el: SVGCircleElement;
  x0: number; y0: number;
  cx: number; cy: number;
  x1: number; y1: number;
  startTime: number;
  duration: number;
  offset: number; // random stagger
}

interface Ripple {
  el: SVGCircleElement;
  startTime: number;
  duration: number;
  x: number;
  y: number;
}

type EventColor = string;

function ledgerTypeColor(type: string): EventColor {
  switch (type) {
    case 'trade': return '#fbbf24';
    case 'alliance': return '#4ade80';
    case 'promise': case 'task': return '#60a5fa';
    case 'rule': return '#a78bfa';
    default: return '#ffffff';
  }
}

function commitmentRippleColor(description: string): { color: string; width: number } {
  const d = description.toLowerCase();
  if (d.includes('oath') || d.includes('swear') || d.includes('vow')) return { color: '#fbbf24', width: 3 };
  if (d.includes('promise') || d.includes('commit') || d.includes('agree')) return { color: '#60a5fa', width: 2 };
  return { color: 'rgba(255,255,255,0.4)', width: 1 };
}

/**
 * Graph effects manager — all visual effects run via direct DOM mutation + rAF.
 * No React state. Returns a ref to attach to the effects <g> layer and
 * a set of active conversation edge IDs for the conversation pulse.
 */
export function useGraphEffects(nodesRef: React.MutableRefObject<SocialNode[]>) {
  const gRef = useRef<SVGGElement | null>(null);
  const particles = useRef<Particle[]>([]);
  const ripples = useRef<Ripple[]>([]);
  const activeConvos = useRef<Map<string, string[]>>(new Map()); // convoId → [agentId, agentId]
  const activeConvoEdges = useRef<Set<string>>(new Set());
  const running = useRef(false);
  const rafRef = useRef(0);

  const getNodePos = useCallback((agentId: string): { x: number; y: number } | null => {
    const node = nodesRef.current.find(n => n.id === agentId);
    return node ? { x: node.x, y: node.y } : null;
  }, [nodesRef]);

  const makeEdgeId = (a: string, b: string) => {
    return a < b ? `${a}-${b}` : `${b}-${a}`;
  };

  // --- Spawn particles along an edge ---
  const spawnParticles = useCallback((fromId: string, toId: string, color: string, count = 3) => {
    const g = gRef.current;
    if (!g) return;
    const from = getNodePos(fromId);
    const to = getNodePos(toId);
    if (!from || !to) return;

    // Cap total particles
    if (particles.current.length >= MAX_PARTICLES) return;

    const { cx, cy } = controlPoint(from.x, from.y, to.x, to.y);
    const now = performance.now();

    for (let i = 0; i < count; i++) {
      const el = document.createElementNS(SVG_NS, 'circle');
      el.setAttribute('r', `${2 + Math.random() * 1.5}`);
      el.setAttribute('fill', color);
      el.setAttribute('opacity', '0.9');
      g.appendChild(el);

      particles.current.push({
        el,
        x0: from.x, y0: from.y,
        cx, cy,
        x1: to.x, y1: to.y,
        startTime: now,
        duration: 700 + Math.random() * 300,
        offset: i * 80, // stagger
      });
    }

    ensureLoop();
  }, [getNodePos]);

  // --- Spawn ripple at a node ---
  const spawnRipple = useCallback((agentId: string, color: string, strokeWidth: number) => {
    const g = gRef.current;
    if (!g) return;
    const pos = getNodePos(agentId);
    if (!pos) return;

    const el = document.createElementNS(SVG_NS, 'circle');
    el.setAttribute('cx', `${pos.x}`);
    el.setAttribute('cy', `${pos.y}`);
    el.setAttribute('r', '20');
    el.setAttribute('fill', 'none');
    el.setAttribute('stroke', color);
    el.setAttribute('stroke-width', `${strokeWidth}`);
    el.setAttribute('opacity', '0.6');
    g.appendChild(el);

    ripples.current.push({
      el,
      startTime: performance.now(),
      duration: 1000,
      x: pos.x,
      y: pos.y,
    });

    ensureLoop();
  }, [getNodePos]);

  // --- Main animation loop ---
  const ensureLoop = useCallback(() => {
    if (running.current) return;
    running.current = true;

    const step = () => {
      const now = performance.now();
      const g = gRef.current;

      // Animate particles
      const aliveParticles: Particle[] = [];
      for (const p of particles.current) {
        const elapsed = now - p.startTime - p.offset;
        if (elapsed < 0) { aliveParticles.push(p); continue; } // not started yet
        const t = Math.min(1, elapsed / p.duration);

        if (t >= 1) {
          p.el.remove();
          continue;
        }

        const pos = bezierPoint(p.x0, p.y0, p.cx, p.cy, p.x1, p.y1, t);
        // Add slight perpendicular wobble
        const wobble = Math.sin(t * Math.PI * 4) * 3;
        const dx = p.x1 - p.x0;
        const dy = p.y1 - p.y0;
        const len = Math.sqrt(dx * dx + dy * dy) || 1;
        p.el.setAttribute('cx', `${pos.x + (-dy / len) * wobble}`);
        p.el.setAttribute('cy', `${pos.y + (dx / len) * wobble}`);

        // Fade out last 30%
        const opacity = t > 0.7 ? 0.9 * (1 - (t - 0.7) / 0.3) : 0.9;
        p.el.setAttribute('opacity', `${opacity}`);

        aliveParticles.push(p);
      }
      particles.current = aliveParticles;

      // Animate ripples
      const aliveRipples: Ripple[] = [];
      for (const r of ripples.current) {
        const t = (now - r.startTime) / r.duration;
        if (t >= 1) {
          r.el.remove();
          continue;
        }

        const radius = 20 + t * 50;
        const opacity = 0.6 * (1 - t);
        r.el.setAttribute('r', `${radius}`);
        r.el.setAttribute('opacity', `${opacity}`);
        aliveRipples.push(r);
      }
      ripples.current = aliveRipples;

      // Keep looping if there's anything alive
      if (particles.current.length > 0 || ripples.current.length > 0) {
        rafRef.current = requestAnimationFrame(step);
      } else {
        running.current = false;
      }
    };

    rafRef.current = requestAnimationFrame(step);
  }, []);

  // --- Subscribe to socket events ---
  useEffect(() => {
    const cleanups: (() => void)[] = [];

    // Conversation start → track active conversations
    cleanups.push(eventBus.on('conversation:start', (data: { conversationId: string; participants: string[] }) => {
      activeConvos.current.set(data.conversationId, data.participants);
      // Build edge ID from participants
      if (data.participants.length >= 2) {
        const edgeId = makeEdgeId(data.participants[0], data.participants[1]);
        activeConvoEdges.current.add(edgeId);
      }
    }));

    // Conversation end → remove
    cleanups.push(eventBus.on('conversation:end', (data: { conversationId: string }) => {
      const participants = activeConvos.current.get(data.conversationId);
      if (participants && participants.length >= 2) {
        const edgeId = makeEdgeId(participants[0], participants[1]);
        activeConvoEdges.current.delete(edgeId);
      }
      activeConvos.current.delete(data.conversationId);
    }));

    // Ledger update → particles + ripple for commitments
    cleanups.push(eventBus.on('ledger:update', (data: { agentId: string; entry: SocialLedgerEntry }) => {
      const entry = data.entry;
      const fromId = entry.proposerId;
      const toIds = entry.targetIds || [];
      const color = ledgerTypeColor(entry.type);

      for (const toId of toIds) {
        spawnParticles(fromId, toId, color, 4);
      }

      // Ripple for promises/tasks
      if (entry.type === 'promise' || entry.type === 'task') {
        const { color: rippleColor, width } = commitmentRippleColor(entry.description);
        spawnRipple(fromId, rippleColor, width);
      }
    }));

    // Reputation change → white particles
    cleanups.push(eventBus.on('reputation:change', (data: { fromId: string; toId: string; score: number }) => {
      const color = data.score > 0 ? '#4ade80' : data.score < 0 ? '#f87171' : '#ffffff';
      spawnParticles(data.fromId, data.toId, color, 3);
    }));

    return () => cleanups.forEach(fn => fn());
  }, [spawnParticles, spawnRipple]);

  // Cleanup on unmount
  useEffect(() => {
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  return {
    effectsRef: gRef,
    activeConvoEdges,
  };
}
