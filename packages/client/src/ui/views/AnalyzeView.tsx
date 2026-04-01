import React, { useEffect, useRef } from 'react';
import { SocialGraph } from '../social/SocialGraph';
import { DataPanel } from '../analyze/DataPanel';

export const AnalyzeView: React.FC = () => {
  const graphRef = useRef<HTMLDivElement>(null);

  // Prevent wheel events on the graph from scrolling the page
  useEffect(() => {
    const el = graphRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => { e.preventDefault(); e.stopPropagation(); };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, []);

  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', overflow: 'hidden' }}>
      {/* Left — Social Graph (takes remaining space) */}
      <div ref={graphRef} style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        <SocialGraph />
      </div>
      {/* Right — Data Panel */}
      <div style={{ width: 420, flexShrink: 0 }}>
        <DataPanel />
      </div>
    </div>
  );
};
