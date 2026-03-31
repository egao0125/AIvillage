import React from 'react';
import { TimeDisplay } from '../components/TimeDisplay';
import { ModeSelector } from './ModeSelector';
import { COLORS } from '../styles';

export const TopNav: React.FC = () => {
  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 10,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '0 8px',
        pointerEvents: 'none',
      }}
    >
      <div style={{ pointerEvents: 'auto' }}>
        <TimeDisplay />
      </div>
      <div style={{ pointerEvents: 'auto' }}>
        <ModeSelector />
      </div>
    </div>
  );
};
