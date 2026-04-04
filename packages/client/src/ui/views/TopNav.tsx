import React from 'react';
import { useWorldTime, useConnected, useWeather } from '../../core/hooks';
import { ModeSelector } from './ModeSelector';
import { UserMenu } from '../components/UserMenu';
import { FONTS } from '../styles';
import { useTheme } from '../ThemeContext';

const WEATHER_ICONS: Record<string, string> = {
  clear: '\u2600\uFE0F',
  rain: '\u{1F327}\uFE0F',
  storm: '\u26C8\uFE0F',
  snow: '\u2744\uFE0F',
  fog: '\u{1F32B}\uFE0F',
  heatwave: '\u{1F525}',
};

interface TopNavProps {
  onChangeMap: () => void;
  onLogout: () => void;
}

export const TopNav: React.FC<TopNavProps> = ({ onChangeMap, onLogout }) => {
  const { colors, isDark, toggle } = useTheme();
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
        top: 8,
        left: 8,
        zIndex: 100,
        display: 'flex',
        alignItems: 'center',
        gap: 0,
        background: colors.bg,
        border: `1px solid ${colors.border}`,
        borderRadius: 6,
        padding: '6px 4px',
        boxShadow: '0 2px 12px rgba(0,0,0,0.4)',
      }}
    >
      {/* User menu — left of everything */}
      <div style={{ marginLeft: 4, marginRight: 4 }}>
        <UserMenu onChangeMap={onChangeMap} onLogout={onLogout} />
      </div>

      {/* Divider */}
      <div style={{ width: 1, height: 16, background: colors.border, marginRight: 8 }} />

      {/* Connected dot */}
      <div
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: connected ? colors.active : colors.warning,
          marginRight: 8,
          flexShrink: 0,
        }}
      />

      {/* Time + weather */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontFamily: FONTS.pixel,
          fontSize: '9px',
          color: colors.text,
          paddingRight: 12,
          borderRight: `1px solid ${colors.border}`,
          whiteSpace: 'nowrap',
        }}
      >
        <span>{timeIcon}</span>
        <span>Day {time.day}</span>
        <span style={{ color: colors.textAccent }}>{hourStr}:{minStr}</span>
        <span style={{ color: colors.textDim }}>·</span>
        <span>{weatherIcon}</span>
        <span>{seasonLabel} {weather.temperature}°</span>
      </div>

      {/* Mode selector */}
      <div style={{ paddingLeft: 8 }}>
        <ModeSelector />
      </div>

      {/* Divider */}
      <div style={{ width: 1, height: 16, background: colors.border, margin: '0 8px' }} />

      {/* Dark mode toggle */}
      <button
        onClick={toggle}
        style={{
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          fontSize: 14,
          padding: '2px 6px',
          lineHeight: 1,
        }}
        title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      >
        {isDark ? '\u2600\uFE0F' : '\u{1F319}'}
      </button>
    </div>
  );
};
