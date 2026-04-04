import React from 'react';
import { useWorldTime, useConnected, useWeather } from '../../core/hooks';
import { FONTS, SIZES } from '../styles';
import { useTheme } from '../ThemeContext';

const WEATHER_ICONS: Record<string, string> = {
  clear: '\u2600\uFE0F',
  rain: '\u{1F327}\uFE0F',
  storm: '\u26C8\uFE0F',
  snow: '\u2744\uFE0F',
  fog: '\u{1F32B}\uFE0F',
  heatwave: '\u{1F525}',
};

export const TimeDisplay: React.FC = () => {
  const { colors } = useTheme();
  const time = useWorldTime();
  const connected = useConnected();
  const weather = useWeather();

  const hourStr = String(time.hour).padStart(2, '0');
  const minStr = String(time.minute).padStart(2, '0');

  const timeIcon = time.hour >= 6 && time.hour < 18 ? '\u2600' : '\u263D';
  const weatherIcon = WEATHER_ICONS[weather.current] || '\u2600\uFE0F';
  const seasonLabel = weather.season.charAt(0).toUpperCase() + weather.season.slice(1);

  return (
    <div
      style={{
        position: 'fixed',
        top: 12,
        left: 12,
        zIndex: 100,
        background: colors.bgCard,
        border: `1px solid ${colors.border}`,
        borderRadius: SIZES.borderRadius,
        padding: '8px 12px',
        fontFamily: FONTS.pixel,
        color: colors.text,
        fontSize: '10px',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span>{timeIcon}</span>
        <span>Day {time.day}</span>
        <span style={{ color: colors.textAccent }}>
          {hourStr}:{minStr}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span>{weatherIcon}</span>
        <span>{seasonLabel}</span>
        <span style={{ color: colors.textDim }}>{weather.temperature}\u00B0</span>
      </div>
      <div
        style={{
          fontSize: '7px',
          color: connected ? colors.active : colors.warning,
        }}
      >
        {connected ? '\u25CF Connected' : '\u25CB Disconnected'}
      </div>
    </div>
  );
};
