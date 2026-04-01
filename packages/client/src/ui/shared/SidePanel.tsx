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

  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        width,
        overflowY: 'auto',
        overflowX: 'hidden',
        overscrollBehavior: 'contain',
        background: COLORS.bg,
        borderLeft: `1px solid ${COLORS.border}`,
        zIndex,
        pointerEvents: 'auto',
        boxSizing: 'border-box',
      }}
    >
      {(onClose || header) && (
        <div
          style={{
            padding: '10px 14px',
            borderBottom: `1px solid ${COLORS.border}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            position: 'sticky',
            top: 0,
            background: COLORS.bg,
            zIndex: 1,
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
      {children}
    </div>
  );
};
