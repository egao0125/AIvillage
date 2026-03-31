import React from 'react';
import { useActiveMode } from '../../core/hooks';
import { TopNav } from './TopNav';
import { App as WatchContent } from '../App';
import { COLORS, FONTS } from '../styles';

const Placeholder: React.FC<{ mode: string }> = ({ mode }) => (
  <div
    style={{
      width: '100%',
      height: '100%',
      position: 'relative',
      background: COLORS.bg,
    }}
  >
    <TopNav />
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: COLORS.textDim,
        fontFamily: FONTS.pixel,
        fontSize: '10px',
        letterSpacing: 1,
      }}
    >
      {mode.toUpperCase()} MODE — COMING SOON
    </div>
  </div>
);

export const AppShell: React.FC = () => {
  const activeMode = useActiveMode();

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      {activeMode === 'watch' && <WatchContent />}
      {activeMode === 'inspect' && <Placeholder mode="inspect" />}
      {activeMode === 'analyze' && <Placeholder mode="analyze" />}
    </div>
  );
};
