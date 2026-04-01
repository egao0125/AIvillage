import React from 'react';
import { COLORS, FONTS } from '../styles';
import { DataPanel } from '../analyze/DataPanel';

export const AnalyzeView: React.FC = () => (
  <div
    style={{
      position: 'absolute',
      inset: 0,
      pointerEvents: 'none',
      display: 'flex',
    }}
  >
    {/* Left -- Social Graph placeholder */}
    <div
      style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        pointerEvents: 'auto',
      }}
    >
      <div style={{ textAlign: 'center' }}>
        <div
          style={{
            fontFamily: FONTS.pixel,
            fontSize: 10,
            color: COLORS.textDim,
            letterSpacing: 2,
          }}
        >
          SOCIAL GRAPH
        </div>
        <div
          style={{
            fontFamily: FONTS.body,
            fontSize: 12,
            color: COLORS.textDim,
            marginTop: 8,
          }}
        >
          Social dynamics visualization coming soon
        </div>
      </div>
    </div>

    {/* Right -- Data Panel */}
    <div style={{ width: 420, pointerEvents: 'auto' }}>
      <DataPanel />
    </div>
  </div>
);
