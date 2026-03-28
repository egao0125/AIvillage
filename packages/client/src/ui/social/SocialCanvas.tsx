import React, { useMemo } from 'react';
import type { SocialNode, SocialEdge } from './types';
import { SocialNodeComponent } from './SocialNode';
import { SocialStringComponent } from './SocialString';
import { useZoomPan } from './useZoomPan';

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
  const { transform, isDefault, onWheel, onPointerDown, onPointerMove, onPointerUp, wasClick, reset } = useZoomPan();

  // Expose reset to parent
  if (zoomPanRef) zoomPanRef.current = { reset };

  // Notify parent when zoom state changes
  React.useEffect(() => {
    onZoomChange?.(isDefault);
  }, [isDefault, onZoomChange]);

  // Node lookup for names
  const nodeMap = useMemo(() => {
    const m = new Map<string, SocialNode>();
    for (const n of nodes) m.set(n.id, n);
    return m;
  }, [nodes]);

  // Node position lookup
  const posMap = useMemo(() => {
    const m = new Map<string, { x: number; y: number }>();
    for (const n of nodes) m.set(n.id, { x: n.x, y: n.y });
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
      style={{ display: 'block', cursor: 'grab' }}
    >
      <g transform={transform}>
        {/* Edges layer */}
        <g>
          {edges.map(edge => {
            const s = posMap.get(edge.source);
            const t = posMap.get(edge.target);
            if (!s || !t) return null;

            const dimmed = connectedToHovered
              ? !connectedToHovered.edgeIds.has(edge.id)
              : false;

            const sourceName = nodeMap.get(edge.source)?.name ?? '?';
            const targetName = nodeMap.get(edge.target)?.name ?? '?';

            return (
              <SocialStringComponent
                key={edge.id}
                edge={edge}
                x1={s.x}
                y1={s.y}
                x2={t.x}
                y2={t.y}
                dimmed={dimmed}
                hovered={hoveredEdgeId === edge.id}
                sourceName={sourceName}
                targetName={targetName}
                onClick={onEdgeClick}
                onMouseEnter={(id) => onEdgeHover(id)}
                onMouseLeave={() => onEdgeHover(null)}
              />
            );
          })}
        </g>

        {/* Nodes layer (rendered on top) */}
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
