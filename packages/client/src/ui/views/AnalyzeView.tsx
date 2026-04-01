import React from 'react';
import { SocialGraph } from '../social/SocialGraph';
import { DataPanel } from '../analyze/DataPanel';
import { SidePanel } from '../shared/SidePanel';
import { ContextPanel } from '../inspect/ContextPanel';
import { useInspectTarget } from '../../core/hooks';
import { gameStore } from '../../core/GameStore';

const PANEL_WIDTH = 420;

export const AnalyzeView: React.FC = () => {
  const inspectTarget = useInspectTarget();

  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', overflow: 'hidden', overscrollBehavior: 'none' }}>
      {/* Left — Social Graph (takes remaining space) */}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        <SocialGraph />
      </div>
      {/* Right — panels container */}
      <div style={{ width: PANEL_WIDTH, flexShrink: 0, position: 'relative' }}>
        <SidePanel position="primary" width={PANEL_WIDTH}>
          <DataPanel />
        </SidePanel>
        {inspectTarget && (
          <SidePanel position="stacked" width={PANEL_WIDTH} onClose={() => gameStore.closeDetail()}>
            <ContextPanel />
          </SidePanel>
        )}
      </div>
    </div>
  );
};
