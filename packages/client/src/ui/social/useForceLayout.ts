import { useEffect, useRef, useState, useCallback } from 'react';
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
  type Simulation,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from 'd3-force';
import type { SocialNode, SocialEdge } from './types';

interface PositionedNode extends SocialNode {
  fx?: number | null;
  fy?: number | null;
  vx?: number;
  vy?: number;
}

interface LayoutResult {
  nodes: PositionedNode[];
  ready: boolean;
}

export function useForceLayout(
  nodes: SocialNode[],
  edges: SocialEdge[],
  width: number,
  height: number,
  enabled: boolean,
): LayoutResult {
  const simRef = useRef<Simulation<PositionedNode, SimulationLinkDatum<PositionedNode>> | null>(null);
  const rafRef = useRef<number>(0);
  const [positioned, setPositioned] = useState<PositionedNode[]>([]);
  const [ready, setReady] = useState(false);

  // Stable node identity: preserve positions across re-renders
  const prevNodesRef = useRef<Map<string, { x: number; y: number }>>(new Map());

  // Re-run simulation when graph structure changes (new agents, new interactions)
  const edgeKey = edges.map(e => `${e.source}-${e.target}`).sort().join(',');

  useEffect(() => {
    if (!enabled || nodes.length === 0 || width === 0) {
      setPositioned([]);
      setReady(false);
      return;
    }

    // Initialize positions from previous layout or random
    const prev = prevNodesRef.current;
    const simNodes: PositionedNode[] = nodes.map(n => {
      const existing = prev.get(n.id);
      return {
        ...n,
        x: existing?.x ?? (width / 2 + (Math.random() - 0.5) * width * 0.5),
        y: existing?.y ?? (height / 2 + (Math.random() - 0.5) * height * 0.5),
      };
    });

    const nodeMap = new Map(simNodes.map(n => [n.id, n]));

    const simLinks = edges
      .filter(e => nodeMap.has(e.source) && nodeMap.has(e.target))
      .map(e => ({
        source: e.source,
        target: e.target,
        interactionCount: e.interactionCount,
      }));

    // Stop previous simulation
    simRef.current?.stop();
    cancelAnimationFrame(rafRef.current);

    const sim = forceSimulation<PositionedNode>(simNodes)
      .force('link', forceLink<PositionedNode, any>(simLinks)
        .id((d: any) => d.id)
        .distance((d: any) => Math.max(120, 280 - d.interactionCount * 15))
        .strength(0.3)
      )
      .force('charge', forceManyBody().strength(-600))
      .force('center', forceCenter(width / 2, height / 2))
      .force('collide', forceCollide(65))
      .alphaDecay(0.05);

    simRef.current = sim;

    // Throttle updates to ~30fps
    let lastTick = 0;
    const tick = () => {
      const now = performance.now();
      if (now - lastTick > 33) {
        lastTick = now;
        const current = simNodes.map(n => ({ ...n }));
        setPositioned(current);

        // Save positions for next re-init
        const posMap = new Map<string, { x: number; y: number }>();
        for (const n of current) {
          posMap.set(n.id, { x: n.x, y: n.y });
        }
        prevNodesRef.current = posMap;

        if (sim.alpha() < 0.01) {
          setReady(true);
        }
      }
      if (sim.alpha() >= 0.001) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        setReady(true);
      }
    };

    sim.on('tick', () => {});
    // Drive with rAF instead of default timer
    sim.stop();

    const runSim = () => {
      sim.tick();
      tick();
      if (sim.alpha() >= 0.001) {
        rafRef.current = requestAnimationFrame(runSim);
      }
    };
    rafRef.current = requestAnimationFrame(runSim);

    return () => {
      sim.stop();
      cancelAnimationFrame(rafRef.current);
    };
  }, [nodes.length, edgeKey, width, height, enabled]);

  return { nodes: positioned, ready };
}

/** Allow dragging a node by fixing its position */
export function useDragNode(
  simRef: React.MutableRefObject<Simulation<any, any> | null>,
) {
  const onDragStart = useCallback((nodeId: string, x: number, y: number) => {
    const sim = simRef.current;
    if (!sim) return;
    sim.alphaTarget(0.3).restart();
    const node = sim.nodes().find((n: any) => n.id === nodeId);
    if (node) {
      (node as any).fx = x;
      (node as any).fy = y;
    }
  }, []);

  const onDrag = useCallback((nodeId: string, x: number, y: number) => {
    const sim = simRef.current;
    if (!sim) return;
    const node = sim.nodes().find((n: any) => n.id === nodeId);
    if (node) {
      (node as any).fx = x;
      (node as any).fy = y;
    }
  }, []);

  const onDragEnd = useCallback((nodeId: string) => {
    const sim = simRef.current;
    if (!sim) return;
    sim.alphaTarget(0);
    const node = sim.nodes().find((n: any) => n.id === nodeId);
    if (node) {
      (node as any).fx = null;
      (node as any).fy = null;
    }
  }, []);

  return { onDragStart, onDrag, onDragEnd };
}
