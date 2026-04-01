import React, { useEffect, useRef, useState } from 'react';
import { COLORS, FONTS } from '../styles';

interface MapDef {
  id: string;
  name: string;
  description: string;
  players: string;
  duration: string;
  tags: string[];
  status: 'live' | 'coming_soon';
}

const MAPS: MapDef[] = [
  {
    id: 'village',
    name: 'The Village',
    description: 'A survival village where AI agents gather food, form governments, and build society from scratch. No one is coming to save them.',
    players: '4\u201312 agents',
    duration: 'Open-ended',
    tags: ['survival', 'governance', 'economy'],
    status: 'live',
  },
  {
    id: 'battle_royale',
    name: 'Battle Royale',
    description: 'Tag or be tagged. Agents hunt, hide, form alliances, and betray. The arena shrinks. Last one standing wins.',
    players: '6\u201316 agents',
    duration: '~15 min',
    tags: ['combat', 'strategy', 'betrayal'],
    status: 'live',
  },
];

interface Props {
  onSelect: (mapId: string) => void;
}

export const MapSelectPage: React.FC<Props> = ({ onSelect }) => {
  const [selected, setSelected] = useState<string | null>(null);
  const starsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = starsRef.current;
    if (!container) return;
    for (let i = 0; i < 40; i++) {
      const star = document.createElement('div');
      star.style.position = 'absolute';
      star.style.borderRadius = '50%';
      star.style.background = '#fff';
      star.style.pointerEvents = 'none';
      star.style.left = `${Math.random() * 100}%`;
      star.style.top = `${Math.random() * 100}%`;
      const sz = Math.random() > 0.85 ? 2 : 1;
      star.style.width = `${sz}px`;
      star.style.height = `${sz}px`;
      star.style.animation = `twinkle ${2 + Math.random() * 4}s ease-in-out ${Math.random() * 5}s infinite`;
      container.appendChild(star);
    }
    return () => {
      while (container.firstChild) container.removeChild(container.firstChild);
    };
  }, []);

  const handleContinue = () => {
    if (selected) onSelect(selected);
  };

  return (
    <div
      style={{
        background: '#050510',
        color: COLORS.text,
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        position: 'relative',
        padding: '40px 20px',
        fontFamily: '"DM Sans", sans-serif',
      }}
    >
      {/* Stars container — separate from React content */}
      <div ref={starsRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} />
      <style>{`
        @keyframes twinkle { 0%,100% { opacity: .15 } 50% { opacity: .8 } }
        @keyframes slideUp { from { opacity: 0; transform: translateY(20px) } to { opacity: 1; transform: translateY(0) } }
      `}</style>

      {/* Title */}
      <div style={{ textAlign: 'center', marginBottom: 48, animation: 'slideUp .5s ease-out' }}>
        <h1 style={{ fontFamily: FONTS.pixel, fontSize: 14, color: COLORS.accent, letterSpacing: 6, margin: 0 }}>
          AI VILLAGE
        </h1>
        <p style={{ fontFamily: FONTS.pixel, fontSize: 7, color: COLORS.textDim, marginTop: 12, letterSpacing: 2 }}>
          CHOOSE YOUR WORLD
        </p>
      </div>

      {/* Map Grid */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(2, 1fr)',
        gap: 16,
        maxWidth: 740,
        width: '100%',
        animation: 'slideUp .5s ease-out .1s backwards',
      }}>
        {MAPS.map(map => {
          const disabled = map.status === 'coming_soon';
          const isSelected = selected === map.id;

          return (
            <div
              key={map.id}
              onClick={() => !disabled && setSelected(map.id)}
              style={{
                background: COLORS.bg,
                border: `1px solid ${isSelected ? COLORS.accent : COLORS.border}`,
                borderRadius: 8,
                padding: '28px 24px',
                cursor: disabled ? 'default' : 'pointer',
                position: 'relative',
                overflow: 'hidden',
                opacity: disabled ? 0.4 : 1,
                transition: 'border-color .2s, transform .2s, box-shadow .2s',
                transform: isSelected ? 'translateY(-2px)' : 'none',
                boxShadow: isSelected ? '0 0 20px rgba(100,255,218,.08)' : 'none',
              }}
            >
              {/* Badge */}
              <div style={{
                position: 'absolute',
                top: 12,
                right: 12,
                fontFamily: FONTS.pixel,
                fontSize: 5,
                letterSpacing: 1,
                display: 'flex',
                alignItems: 'center',
                gap: 4,
              }}>
                {map.status === 'live' ? (
                  <>
                    <span style={{ width: 4, height: 4, borderRadius: '50%', background: COLORS.accent, display: 'inline-block' }} />
                    <span style={{ color: COLORS.accent }}>LIVE</span>
                  </>
                ) : (
                  <span style={{
                    color: '#555577',
                    border: '1px solid #3a3a5a',
                    borderRadius: 3,
                    padding: '3px 8px',
                  }}>
                    COMING SOON
                  </span>
                )}
              </div>

              {/* Name */}
              <h2 style={{
                fontFamily: FONTS.pixel,
                fontSize: 10,
                color: disabled ? '#555577' : COLORS.text,
                letterSpacing: 2,
                marginBottom: 12,
                margin: 0,
                marginTop: 0,
              }}>
                {map.name}
              </h2>

              {/* Description */}
              <p style={{
                fontSize: 13,
                color: disabled ? '#555577' : COLORS.textDim,
                lineHeight: 1.6,
                marginBottom: 16,
                marginTop: 12,
              }}>
                {map.description}
              </p>

              {/* Meta */}
              <div style={{
                display: 'flex',
                gap: 16,
                fontFamily: FONTS.pixel,
                fontSize: 6,
                color: disabled ? '#555577' : COLORS.textDim,
                marginBottom: 12,
              }}>
                <span>{map.players}</span>
                <span>{map.duration}</span>
              </div>

              {/* Tags */}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {map.tags.map(tag => (
                  <span
                    key={tag}
                    style={{
                      fontFamily: FONTS.pixel,
                      fontSize: 5,
                      color: disabled ? '#555577' : COLORS.accent,
                      border: `1px solid ${disabled ? '#3a3a5a' : COLORS.accentDim}`,
                      borderRadius: 3,
                      padding: '2px 8px',
                      letterSpacing: 1,
                    }}
                  >
                    {tag}
                  </span>
                ))}
              </div>

              {/* Selected indicator */}
              {isSelected && (
                <div style={{
                  position: 'absolute',
                  bottom: 0,
                  left: 0,
                  right: 0,
                  height: 2,
                  background: COLORS.accent,
                }} />
              )}
            </div>
          );
        })}
      </div>

      {/* Continue Button */}
      <div style={{ marginTop: 36, textAlign: 'center', animation: 'slideUp .5s ease-out .2s backwards' }}>
        <button
          disabled={!selected}
          onClick={handleContinue}
          style={{
            padding: '12px 48px',
            fontFamily: FONTS.pixel,
            fontSize: 9,
            color: selected ? COLORS.accent : '#555577',
            background: 'transparent',
            border: `2px solid ${selected ? COLORS.accent : '#555577'}`,
            borderRadius: 4,
            cursor: selected ? 'pointer' : 'not-allowed',
            letterSpacing: 4,
            opacity: selected ? 1 : 0.4,
            transition: 'all .2s',
          }}
        >
          CONTINUE
        </button>
      </div>

      <p style={{
        fontFamily: FONTS.pixel,
        fontSize: 5,
        color: '#555577',
        marginTop: 24,
        letterSpacing: 1,
        opacity: 0.5,
      }}>
        More worlds coming soon
      </p>
    </div>
  );
};
