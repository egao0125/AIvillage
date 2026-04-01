import React from 'react';
import { ContextPanel } from '../inspect/ContextPanel';

export const InspectView: React.FC = () => (
  <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
    <div style={{ position: 'absolute', top: 0, right: 0, bottom: 0, width: 420, pointerEvents: 'auto' }}>
      <ContextPanel />
    </div>
  </div>
);
