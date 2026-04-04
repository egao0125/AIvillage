import React from 'react';
import { useTheme } from '../ThemeContext';
import { VillageStatus } from './VillageStatus';
import { VillageHistory } from './VillageHistory';
import { ElectionsPanel } from './ElectionsPanel';
import { InstitutionsPanel } from './InstitutionsPanel';
import { RulesPanel } from './RulesPanel';

export const DataPanel: React.FC = () => {
  const { colors } = useTheme();

  const divider: React.CSSProperties = {
    height: 1,
    background: colors.border,
    opacity: 0.3,
    margin: '12px 0',
  };

  return (
    <div style={{ padding: 16 }}>
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
};
