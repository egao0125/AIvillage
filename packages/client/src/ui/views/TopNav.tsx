import React from 'react';
import { useWorldTime, useConnected, useWeather } from '../../core/hooks';
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
  onOpenAgentCreator: () => void;
  onChangeMap: () => void;
  onLogout: () => void;
}

export const TopNav: React.FC<TopNavProps> = ({ onOpenAgentCreator, onChangeMap, onLogout }) => {
  const time = useWorldTime();
  const connected = useConnected();
  const weather = useWeather();

  const hourStr = String(time.hour).padStart(2, '0');
  const minStr = String(time.minute).padStart(2, '0');
  const timeIcon = time.hour >= 6 && time.hour < 18 ? '\u2600' : '\u263D';
  const weatherIcon = WEATHER_ICONS[weather.current] || '\u2600\uFE0F';
  const seasonLabel = weather.season.charAt(0).toUpperCase() + weather.season.slice(1);

  return (
    <>
      {/* Left bar — time, weather, mode selector */}
      <div
        style={{
          position: 'fixed',
          top: 8,
          left: 8,
          zIndex: 100,
          display: 'flex',
          alignItems: 'center',
          gap: 0,
          background: COLORS.bg,
          border: `1px solid ${COLORS.border}`,
          borderRadius: 6,
          padding: '6px 4px',
          boxShadow: '0 2px 12px rgba(0,0,0,0.4)',
        }}
      >
        {/* Connected dot */}
        <div
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: connected ? COLORS.active : COLORS.warning,
            marginLeft: 8,
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
            color: COLORS.text,
            paddingRight: 12,
            borderRight: `1px solid ${COLORS.border}`,
            whiteSpace: 'nowrap',
          }}
        >
          <span>{timeIcon}</span>
          <span>Day {time.day}</span>
          <span style={{ color: COLORS.textAccent }}>{hourStr}:{minStr}</span>
          <span style={{ color: COLORS.textDim }}>·</span>
          <span>{weatherIcon}</span>
          <span>{seasonLabel} {weather.temperature}°</span>
        </div>

        {/* Mode selector */}
        <div style={{ paddingLeft: 8 }}>
          <ModeSelector />
        </div>
      </div>

      {/* Right bar — add agent + user menu */}
      <div
        style={{
          position: 'fixed',
          top: 8,
          right: 8,
          zIndex: 100,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <button
          onClick={onOpenAgentCreator}
          style={{
            background: COLORS.bg,
            border: `1px solid ${COLORS.accent}`,
            borderRadius: 4,
            padding: '4px 10px',
            fontFamily: FONTS.pixel,
            fontSize: 10,
            color: COLORS.accent,
            cursor: 'pointer',
            lineHeight: 1,
          }}
        >
          +
        </button>
        <UserMenu onChangeMap={onChangeMap} onLogout={onLogout} />
      </div>
    </>
  );
};
