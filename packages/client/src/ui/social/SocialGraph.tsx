import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { FONTS, LIGHT_COLORS } from '../styles';
import { useTheme } from '../ThemeContext';
import { useSocialGraph } from './useSocialGraph';
import { useForceLayout } from './useForceLayout';
import { useMapLayout } from './useMapLayout';
import { SocialCanvas } from './SocialCanvas';
import { SocialDetailPanel } from './SocialDetailPanel';
import { SocialControls } from './SocialControls';
import { SOCIAL_KEYFRAMES } from './socialAnimations';
import type { LayoutMode, SocialFilter, SocialNode } from './types';
import { DEFAULT_FILTER } from './types';

class SocialGraphErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (this.state.error) {
      return (
        <div style={{ position: 'absolute', inset: 0, background: LIGHT_COLORS.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 12 }}>
          <div style={{ color: LIGHT_COLORS.warning, fontFamily: FONTS.pixel, fontSize: 12 }}>SOCIAL VIEW ERROR</div>
          <div style={{ color: LIGHT_COLORS.textDim, fontFamily: FONTS.body, fontSize: 12, maxWidth: 500, textAlign: 'center' }}>{this.state.error.message}</div>
        </div>
      );
    }
    return this.props.children;
  }
}

export const SocialGraph: React.FC = () => (
  <SocialGraphErrorBoundary>
    <SocialGraphInner />
  </SocialGraphErrorBoundary>
);

const SocialGraphInner: React.FC = () => {
  const { colors } = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const [layout, setLayout] = useState<LayoutMode>('force');
  const [filter, setFilter] = useState<SocialFilter>(DEFAULT_FILTER);

  // Selection / hover state
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [zoomIsDefault, setZoomIsDefault] = useState(true);
  const [legendVisible, setLegendVisible] = useState(true);
  const zoomPanRef = useRef<{ reset: () => void } | null>(null);

  // Measure container
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect;
      setDimensions({ width, height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Derive graph data
  const { nodes, edges } = useSocialGraph(filter);

  // Account for detail panel width
  const hasPanel = selectedNodeId !== null || selectedEdgeId !== null;
  const svgWidth = hasPanel ? Math.max(0, dimensions.width - 350) : dimensions.width;
  const svgHeight = Math.max(0, dimensions.height);

  // Force layout
  const { nodes: forceNodes } = useForceLayout(
    nodes, edges, svgWidth, svgHeight, layout === 'force',
  );

  // Map layout
  const mapNodes = useMapLayout(nodes, svgWidth, svgHeight, layout === 'map');

  // Use layout output directly — no spring interpolation layer
  // Merge _dimmed flags from search-filtered nodes back onto positioned nodes
  const rawNodes = layout === 'force' ? forceNodes : mapNodes;
  const dimmedMap = useMemo(() => {
    const m = new Map<string, boolean>();
    for (const n of nodes) {
      if (n._dimmed) m.set(n.id, true);
    }
    return m;
  }, [nodes]);

  const displayNodes: SocialNode[] = useMemo(() => {
    const positioned = rawNodes.length > 0 ? rawNodes : nodes;
    return positioned.map((n, i) => {
      const x = (n.x !== 0 || n.y !== 0) ? n.x : svgWidth / 2 + Math.min(svgWidth, svgHeight) * 0.3 * Math.cos((2 * Math.PI * i) / Math.max(positioned.length, 1));
      const y = (n.x !== 0 || n.y !== 0) ? n.y : svgHeight / 2 + Math.min(svgWidth, svgHeight) * 0.3 * Math.sin((2 * Math.PI * i) / Math.max(positioned.length, 1));
      return { ...n, x, y, _dimmed: dimmedMap.get(n.id) ?? false };
    });
  }, [rawNodes, nodes, dimmedMap, svgWidth, svgHeight]);

  // Close detail panel
  const closePanel = useCallback(() => {
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
  }, []);

  // Keyboard: Escape closes detail panel
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (selectedNodeId || selectedEdgeId) {
          closePanel();
        }
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [selectedNodeId, selectedEdgeId, closePanel]);

  // Build detail panel props
  const selectedNode = selectedNodeId ? displayNodes.find(n => n.id === selectedNodeId) : null;
  const selectedEdge = selectedEdgeId ? edges.find(e => e.id === selectedEdgeId) : null;

  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        background: colors.bg,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Inject keyframes */}
      <style>{SOCIAL_KEYFRAMES}</style>

      {/* Canvas area — fills entire space */}
      <div
        ref={containerRef}
        style={{ flex: 1, position: 'relative', overflow: 'hidden' }}
      >
        {/* Controls — floating under TopNav */}
        <div style={{ position: 'absolute', top: 48, left: 8, zIndex: 5 }}>
          <SocialControls
            layout={layout}
            onLayoutChange={setLayout}
            filter={filter}
            onFilterChange={setFilter}
          />
        </div>
        {dimensions.width > 0 && (
          <SocialCanvas
            nodes={displayNodes}
            edges={edges}
            width={svgWidth}
            height={svgHeight}
            hoveredNodeId={hoveredNodeId}
            hoveredEdgeId={hoveredEdgeId}
            selectedNodeId={selectedNodeId}
            zoomPanRef={zoomPanRef}
            onZoomChange={setZoomIsDefault}
            selectedEdgeId={selectedEdgeId}
            onNodeHover={setHoveredNodeId}
            onEdgeHover={setHoveredEdgeId}
            onNodeClick={(id) => {
              setSelectedNodeId(id);
              setSelectedEdgeId(null);
            }}
            onEdgeClick={(id) => {
              setSelectedEdgeId(id);
              setSelectedNodeId(null);
            }}
            onBackgroundClick={closePanel}
          />
        )}

        {/* Detail panel */}
        {selectedNode && (
          <SocialDetailPanel
            type="node"
            props={{
              node: selectedNode,
              edges,
              allNodes: displayNodes,
              onClose: closePanel,
            }}
            onClose={closePanel}
          />
        )}
        {selectedEdge && !selectedNode && (
          <SocialDetailPanel
            type="edge"
            props={{
              edge: selectedEdge,
              allNodes: displayNodes,
              onClose: closePanel,
            }}
            onClose={closePanel}
          />
        )}

        {/* Empty state */}
        {nodes.length === 0 && (
          <div style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            textAlign: 'center',
          }}>
            <div style={{ color: colors.textDim, fontFamily: FONTS.pixel, fontSize: 12, letterSpacing: 1 }}>
              NO AGENTS
            </div>
            <div style={{ color: colors.textDim, fontFamily: FONTS.body, fontSize: 12, marginTop: 8 }}>
              Add agents to the village to see social dynamics.
            </div>
          </div>
        )}
        {nodes.length > 0 && edges.length === 0 && (
          <div style={{
            position: 'absolute',
            bottom: 24,
            left: '50%',
            transform: 'translateX(-50%)',
            textAlign: 'center',
            padding: '8px 16px',
            background: colors.bgCard,
            borderRadius: 6,
            border: `1px solid ${colors.border}`,
          }}>
            <div style={{ color: colors.textDim, fontFamily: FONTS.body, fontSize: 11 }}>
              No connections yet — agents need to interact before relationships appear.
            </div>
          </div>
        )}

        {/* Reset zoom button */}
        {!zoomIsDefault && (
          <button
            onClick={() => zoomPanRef.current?.reset()}
            style={{
              position: 'absolute',
              top: 12,
              right: hasPanel ? 362 : 12,
              padding: '4px 10px',
              background: colors.bgCard,
              border: `1px solid ${colors.border}`,
              borderRadius: 4,
              color: colors.textDim,
              cursor: 'pointer',
              fontFamily: FONTS.pixel,
              fontSize: 8,
              letterSpacing: 1,
              zIndex: 2,
            }}
          >
            RESET VIEW
          </button>
        )}

        {/* Legend */}
        {legendVisible && nodes.length > 0 && (
          <div style={{
            position: 'absolute',
            bottom: 16,
            right: hasPanel ? 366 : 16,
            padding: '10px 14px',
            background: `${colors.bgCard}ee`,
            border: `1px solid ${colors.border}`,
            borderRadius: 6,
            fontFamily: FONTS.body,
            fontSize: 10,
            color: colors.textDim,
            lineHeight: 1.8,
            zIndex: 2,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <span style={{ fontFamily: FONTS.pixel, fontSize: 8, letterSpacing: 1, color: colors.text }}>LEGEND</span>
              <span onClick={() => setLegendVisible(false)} style={{ cursor: 'pointer', fontSize: 12, lineHeight: 1 }}>&times;</span>
            </div>
            <div><span style={{ color: colors.text }}>---</span> thick line = many interactions</div>
            <div><span style={{ color: 'hsl(140, 75%, 50%)' }}>---</span> green = trust &nbsp; <span style={{ color: 'hsl(0, 70%, 45%)' }}>---</span> red = distrust</div>
            <div><span style={{ color: '#ff4444' }}>{'\u25cf'}</span> red pulse = conflict / disagreement</div>
            <div><span style={{ color: '#a78bfa' }}>{'\u25cb'}</span> ring color = agent mood</div>
            <div><span style={{ color: '#fbbf24' }}>{'\u25cf'}</span> traveling dot = active conversation</div>
            <div style={{ color: colors.textDim, marginTop: 2 }}>Scroll to zoom &middot; Drag to pan</div>
          </div>
        )}
      </div>
    </div>
  );
};
