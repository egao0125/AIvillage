import React from 'react';
import { SocialGraph } from '../social/SocialGraph';
import { DataPanel } from '../analyze/DataPanel';

export const AnalyzeView: React.FC = () => (
  <div style={{ position: 'absolute', inset: 0, display: 'flex', overflow: 'hidden', overscrollBehavior: 'none' }}>
    {/* Left — Social Graph (takes remaining space) */}
    <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
      <SocialGraph />
    </div>
    {/* Right — Data Panel */}
    <div style={{ width: 420, flexShrink: 0 }}>
      <DataPanel />
    </div>
  </div>
);
