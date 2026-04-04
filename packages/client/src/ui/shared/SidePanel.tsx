import React from 'react';
import { COLORS, FONTS } from '../styles';

interface SidePanelProps {
  width?: number;
  position: 'primary' | 'stacked';
  onClose?: () => void;
  header?: React.ReactNode;
  children: React.ReactNode;
}

export const SidePanel: React.FC<SidePanelProps> = ({
  width = 420,
  position,
  onClose,
  header,
  children,
}) => {
  const zIndex = position === 'stacked' ? 15 : 10;
  const isFull = width >= window.innerWidth;
  const right = isFull ? 0 : position === 'stacked' ? width : 0;

  return (
    // Outer wrapper: solid background, no scroll — never reveals canvas
    <div
      style={{
        position: 'absolute',
        top: 0,
        right,
        bottom: 0,
        width: isFull ? '100%' : width,
        background: COLORS.bg,
        borderLeft: `1px solid ${COLORS.border}`,
        zIndex,
        pointerEvents: 'auto',
        boxSizing: 'border-box',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Sticky header */}
      {(onClose || header) && (
        <div
          style={{
            padding: '10px 14px',
            borderBottom: `1px solid ${COLORS.border}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            background: COLORS.bg,
            flexShrink: 0,
          }}
        >
          <div>{header}</div>
          {onClose && (
            <button
              onClick={onClose}
              style={{
                background: 'none',
                border: 'none',
                color: COLORS.textDim,
                cursor: 'pointer',
                fontSize: '14px',
                fontFamily: FONTS.body,
                padding: 0,
                lineHeight: 1,
              }}
            >
              ✕
            </button>
          )}
        </div>
      )}

      {/* Inner scrollable area — rubber-band stays inside the solid outer wrapper */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          overflowX: 'hidden',
          overscrollBehavior: 'contain',
          minHeight: 0,
        }}
      >
        {children}
      </div>
    </div>
  );
};
