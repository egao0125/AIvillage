import React from 'react';
import { useWorldTime, useConnected, useWeather, useIsMobile } from '../../core/hooks';
import { ModeSelector } from './ModeSelector';
import { UserMenu } from '../components/UserMenu';
import { COLORS, FONTS } from '../styles';

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
  const time = useWorldTime();
  const connected = useConnected();
  const weather = useWeather();
  const isMobile = useIsMobile();

  const hourStr = String(time.hour).padStart(2, '0');
  const minStr = String(time.minute).padStart(2, '0');
  const timeIcon = time.hour >= 6 && time.hour < 18 ? '\u2600' : '\u263D';
  const weatherIcon = WEATHER_ICONS[weather.current] || '\u2600\uFE0F';
  const seasonLabel = weather.season.charAt(0).toUpperCase() + weather.season.slice(1);

  return (
    <div
      style={{
        position: 'fixed',
        top: isMobile ? 4 : 8,
        left: isMobile ? 4 : 8,
        right: isMobile ? 4 : undefined,
        zIndex: 100,
        display: 'flex',
        alignItems: 'center',
        gap: 0,
        background: COLORS.bg,
        border: `1px solid ${COLORS.border}`,
        borderRadius: 6,
        padding: isMobile ? '8px 6px' : '6px 4px',
        boxShadow: '0 2px 12px rgba(0,0,0,0.4)',
      }}
    >
      {/* User menu — left of everything */}
      <div style={{ marginLeft: 4, marginRight: 4 }}>
        <UserMenu onChangeMap={onChangeMap} onLogout={onLogout} />
      </div>

      {/* Divider */}
      <div style={{ width: 1, height: 16, background: COLORS.border, marginRight: 8 }} />

      {/* Connected dot */}
      <div
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: connected ? COLORS.active : COLORS.warning,
          marginRight: 8,
          flexShrink: 0,
        }}
      />

      {/* Time + weather */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: isMobile ? 4 : 6,
          fontFamily: FONTS.pixel,
          fontSize: isMobile ? '7px' : '9px',
          color: COLORS.text,
          paddingRight: isMobile ? 8 : 12,
          borderRight: `1px solid ${COLORS.border}`,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          flex: 1,
          minWidth: 0,
        }}
      >
        <span>{timeIcon}</span>
        <span>Day {time.day}</span>
        <span style={{ color: COLORS.textAccent }}>{hourStr}:{minStr}</span>
        {!isMobile && <span style={{ color: COLORS.textDim }}>·</span>}
        {!isMobile && <span>{weatherIcon}</span>}
        {!isMobile && <span>{seasonLabel} {weather.temperature}°</span>}
      </div>

      {/* Mode selector */}
      <div style={{ paddingLeft: 8, flexShrink: 0 }}>
        <ModeSelector />
      </div>
    </div>
  );
};
