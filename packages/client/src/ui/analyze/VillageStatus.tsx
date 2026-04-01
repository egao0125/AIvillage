import React from 'react';
import { COLORS, FONTS } from '../styles';
import { useAgents, useWorldTime, useWeather, useBuildings } from '../../core/hooks';

const statCard: React.CSSProperties = {
  background: COLORS.bgCard,
  border: `1px solid ${COLORS.border}`,
  borderRadius: 4,
  padding: 12,
  textAlign: 'center',
};

const labelStyle: React.CSSProperties = {
  fontFamily: FONTS.pixel,
  fontSize: 6,
  color: COLORS.textDim,
  textTransform: 'uppercase',
  letterSpacing: 1,
};

const valueStyle: React.CSSProperties = {
  fontFamily: FONTS.pixel,
  fontSize: 12,
  color: COLORS.text,
  marginTop: 6,
};

const weatherIcon = (current: string): string => {
  const icons: Record<string, string> = {
    clear: '\u2600',
    rain: '\uD83C\uDF27',
    storm: '\u26C8',
    snow: '\u2744',
    fog: '\uD83C\uDF2B',
    heatwave: '\uD83D\uDD25',
  };
  return icons[current] ?? '\uD83C\uDF24';
};

const seasonName = (season: string): string =>
  season.charAt(0).toUpperCase() + season.slice(1);

export const VillageStatus: React.FC = () => {
  const agents = useAgents();
  const time = useWorldTime();
  const weather = useWeather();
  const buildings = useBuildings();

  const aliveCount = agents.filter((a) => a.alive !== false).length;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 8 }}>
      <div style={statCard}>
        <div style={labelStyle}>Population</div>
        <div style={valueStyle}>{aliveCount}</div>
      </div>

      <div style={statCard}>
        <div style={labelStyle}>Day / Season</div>
        <div style={valueStyle}>
          {time.day} / {seasonName(weather.season)}
        </div>
      </div>

      <div style={statCard}>
        <div style={labelStyle}>Weather</div>
        <div style={valueStyle}>
          {weatherIcon(weather.current)} {weather.current} {weather.temperature}°
        </div>
      </div>

      <div style={statCard}>
        <div style={labelStyle}>Buildings</div>
        <div style={valueStyle}>{buildings.length}</div>
      </div>
    </div>
  );
};
