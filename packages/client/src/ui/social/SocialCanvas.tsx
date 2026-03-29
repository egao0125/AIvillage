import React, { useMemo, useRef } from 'react';
import type { SocialNode, SocialEdge } from './types';
import { SocialNodeComponent } from './SocialNode';
import { SocialStringComponent } from './SocialString';
import { useZoomPan } from './useZoomPan';
import { useGraphEffects } from './useGraphEffects';

interface SocialCanvasProps {
  nodes: SocialNode[];
  edges: SocialEdge[];
  width: number;
  height: number;
  hoveredNodeId: string | null;
  hoveredEdgeId: string | null;
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  onNodeHover: (id: string | null) => void;
  onEdgeHover: (id: string | null) => void;
  onNodeClick: (id: string) => void;
  onEdgeClick: (id: string) => void;
  onBackgroundClick: () => void;
  onZoomChange?: (isDefault: boolean) => void;
  zoomPanRef?: React.MutableRefObject<{ reset: () => void } | null>;
}

export const SocialCanvas: React.FC<SocialCanvasProps> = ({
  nodes, edges, width, height,
  hoveredNodeId, hoveredEdgeId, selectedNodeId, selectedEdgeId,
  onNodeHover, onEdgeHover, onNodeClick, onEdgeClick, onBackgroundClick,
  onZoomChange, zoomPanRef,
}) => {
  const { gRef, onWheel, onPointerDown, onPointerMove, onPointerUp, wasClick, reset, onDefaultChange } = useZoomPan();

  // Keep a ref to current nodes for effect position lookups
  const nodesRef = useRef<SocialNode[]>(nodes);
  nodesRef.current = nodes;

  const { effectsRef, activeConvoEdges } = useGraphEffects(nodesRef);

  // Expose reset to parent
  if (zoomPanRef) zoomPanRef.current = { reset };
  onDefaultChange.current = onZoomChange ?? null;

  // Node lookup for names
  const nodeMap = useMemo(() => {
    const m = new Map<string, SocialNode>();
    for (const n of nodes) m.set(n.id, n);
    return m;
  }, [nodes]);

  // Determine which nodes/edges are connected to hovered node
  const connectedToHovered = useMemo(() => {
    if (!hoveredNodeId) return null;
    const nodeIds = new Set<string>([hoveredNodeId]);
    const edgeIds = new Set<string>();
    for (const e of edges) {
      if (e.source === hoveredNodeId || e.target === hoveredNodeId) {
        edgeIds.add(e.id);
        nodeIds.add(e.source);
        nodeIds.add(e.target);
      }
    }
    return { nodeIds, edgeIds };
  }, [hoveredNodeId, edges]);

  return (
    <svg
      width={width}
      height={height}
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onClick={(e) => {
        if (e.target === e.currentTarget && wasClick()) onBackgroundClick();
      }}
      style={{ display: 'block', cursor: 'grab', background: '#0a0a1a' }}
    >
      <defs>
        <radialGradient id="node-gradient" cx="35%" cy="35%">
          <stop offset="0%" stopColor="#2a3a5e" />
          <stop offset="100%" stopColor="#0f1629" />
        </radialGradient>
      </defs>

      {/* Subtle background dot grid */}
      <pattern id="dot-grid" x="0" y="0" width="30" height="30" patternUnits="userSpaceOnUse">
        <circle cx="15" cy="15" r="0.5" fill="rgba(100,255,218,0.08)" />
      </pattern>
      <rect width={width} height={height} fill="url(#dot-grid)" />

      <g ref={gRef}>
        {/* Edges layer */}
        <g>
          {edges.map(edge => {
            const sNode = nodeMap.get(edge.source);
            const tNode = nodeMap.get(edge.target);
            if (!sNode || !tNode) return null;

            const dimmed = connectedToHovered
              ? !connectedToHovered.edgeIds.has(edge.id)
              : false;

            return (
              <SocialStringComponent
                key={edge.id}
                edge={edge}
                x1={sNode.x}
                y1={sNode.y}
                x2={tNode.x}
                y2={tNode.y}
                dimmed={dimmed}
                hovered={hoveredEdgeId === edge.id}
                sourceName={sNode.name}
                targetName={tNode.name}
                activeConversation={activeConvoEdges.current.has(edge.id)}
                onClick={onEdgeClick}
                onMouseEnter={(id) => onEdgeHover(id)}
                onMouseLeave={() => onEdgeHover(null)}
              />
            );
          })}
        </g>

        {/* Effects layer (particles + ripples) — between edges and nodes */}
        <g ref={effectsRef} />

        {/* Nodes layer */}
        <g>
          {nodes.map(node => {
            const dimmed = connectedToHovered
              ? !connectedToHovered.nodeIds.has(node.id)
              : false;

            return (
              <SocialNodeComponent
                key={node.id}
                id={node.id}
                name={node.name}
                mood={node.mood}
                state={node.state}
                x={node.x}
                y={node.y}
                connectionCount={edges.filter(e => e.source === node.id || e.target === node.id).length}
                dimmed={dimmed || (node as any)._dimmed === true}
                selected={selectedNodeId === node.id}
                hovered={hoveredNodeId === node.id}
                onMouseEnter={(id) => onNodeHover(id)}
                onMouseLeave={() => onNodeHover(null)}
                onClick={onNodeClick}
              />
            );
          })}
        </g>
      </g>
    </svg>
  );
};
