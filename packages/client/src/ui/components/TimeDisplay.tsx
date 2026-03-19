import React from 'react';
import { useWorldTime, useConnected } from '../../core/hooks';
import { COLORS, FONTS, SIZES } from '../styles';

export const TimeDisplay: React.FC = () => {
  const time = useWorldTime();
  const connected = useConnected();

  const hourStr = String(time.hour).padStart(2, '0');
  const minStr = String(time.minute).padStart(2, '0');

  const timeIcon = time.hour >= 6 && time.hour < 18 ? '\u2600' : '\u263D';

  return (
    <div
      style={{
        position: 'fixed',
        top: 12,
        left: 12,
        zIndex: 100,
        background: COLORS.bgCard,
        border: `1px solid ${COLORS.border}`,
        borderRadius: SIZES.borderRadius,
        padding: '8px 12px',
        fontFamily: FONTS.pixel,
        color: COLORS.text,
        fontSize: '10px',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span>{timeIcon}</span>
        <span>Day {time.day}</span>
        <span style={{ color: COLORS.textAccent }}>
          {hourStr}:{minStr}
        </span>
      </div>
      <div
        style={{
          fontSize: '7px',
          color: connected ? COLORS.active : COLORS.warning,
        }}
      >
        {connected ? '\u25CF Connected' : '\u25CB Disconnected'}
      </div>
    </div>
  );
};
