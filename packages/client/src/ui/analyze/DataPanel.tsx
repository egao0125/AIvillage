import React from 'react';
import { COLORS } from '../styles';
import { VillageStatus } from './VillageStatus';
import { VillageHistory } from './VillageHistory';
import { ElectionsPanel } from './ElectionsPanel';
import { InstitutionsPanel } from './InstitutionsPanel';
import { RulesPanel } from './RulesPanel';

const divider: React.CSSProperties = {
  height: 1,
  background: COLORS.border,
  opacity: 0.3,
  margin: '12px 0',
};

export const DataPanel: React.FC = () => (
  <div
    style={{
      width: 420,
      height: '100%',
      overflowY: 'auto',
      overscrollBehavior: 'contain',
      background: COLORS.bg,
      borderLeft: `1px solid ${COLORS.border}`,
      padding: 16,
      boxSizing: 'border-box',
    }}
  >
    <VillageStatus />
    <div style={divider} />
    <VillageHistory />
    <div style={divider} />
    <ElectionsPanel />
    <div style={divider} />
    <InstitutionsPanel />
    <div style={divider} />
    <RulesPanel />
  </div>
);
