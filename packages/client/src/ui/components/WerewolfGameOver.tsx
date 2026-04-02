import React, { useEffect, useState } from 'react';
import type { WerewolfGameOverPayload } from '@ai-village/shared';
import { COLORS, FONTS } from '../styles';

interface Props {
  payload: WerewolfGameOverPayload;
  onPlayAgain: () => void;
  onBackToMenu: () => void;
}

const ROLE_COLORS: Record<string, string> = {
  werewolf: '#e53e3e',
  sheriff: '#d69e2e',
  healer: '#38a169',
  villager: '#4299e1',
};

const ROLE_ICONS: Record<string, string> = {
  werewolf: '\uD83D\uDC3A',
  sheriff: '\uD83D\uDD0D',
  healer: '\u2764\uFE0F',
  villager: '\uD83C\uDFE0',
};

const PHASE_ICONS: Record<string, string> = {
  night: '\uD83C\uDF19',
  dawn: '\uD83C\uDF05',
  day: '\u2600\uFE0F',
  vote: '\uD83D\uDDF3\uFE0F',
};

export const WerewolfGameOver: React.FC<Props> = ({ payload, onPlayAgain, onBackToMenu }) => {
  const [revealedCards, setRevealedCards] = useState(0);
  const [showTimeline, setShowTimeline] = useState(false);
  const [showStats, setShowStats] = useState(false);

  // Animate card reveals one by one
  useEffect(() => {
    const total = payload.roles.length;
    if (revealedCards < total) {
      const timer = setTimeout(() => setRevealedCards(prev => prev + 1), 500);
      return () => clearTimeout(timer);
    } else {
      // All cards revealed, show timeline + stats
      const timer = setTimeout(() => {
        setShowTimeline(true);
        setShowStats(true);
      }, 600);
      return () => clearTimeout(timer);
    }
  }, [revealedCards, payload.roles.length]);

  const isVillagersWin = payload.winner === 'villagers';

  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      zIndex: 1000,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      overflow: 'auto',
      background: 'linear-gradient(180deg, #0a0a1a 0%, #1a0a2e 50%, #0a0a1a 100%)',
    }}>
      {/* Winner banner */}
      <div style={{
        width: '100%',
        padding: '32px 0',
        textAlign: 'center',
        background: isVillagersWin
          ? 'linear-gradient(135deg, rgba(56,161,105,0.3) 0%, rgba(56,161,105,0.1) 100%)'
          : 'linear-gradient(135deg, rgba(229,62,62,0.3) 0%, rgba(229,62,62,0.1) 100%)',
        borderBottom: `2px solid ${isVillagersWin ? '#38a169' : '#e53e3e'}`,
      }}>
        <h1 style={{
          fontFamily: FONTS.pixel,
          fontSize: 20,
          color: isVillagersWin ? '#68d391' : '#fc8181',
          margin: 0,
          letterSpacing: 3,
          textTransform: 'uppercase',
        }}>
          {isVillagersWin ? 'The Village Survives' : 'The Wolves Prevail'}
        </h1>
        <p style={{
          fontFamily: FONTS.body,
          fontSize: 14,
          color: COLORS.textDim,
          margin: '8px 0 0',
        }}>
          {isVillagersWin
            ? 'All werewolves have been eliminated.'
            : 'The werewolves have overtaken the village.'}
        </p>
      </div>

      {/* Role reveal cards */}
      <div style={{
        display: 'flex',
        flexWrap: 'wrap',
        justifyContent: 'center',
        gap: 12,
        padding: '24px 16px',
        maxWidth: 900,
      }}>
        {payload.roles.map((r, i) => {
          const isRevealed = i < revealedCards;
          const roleColor = ROLE_COLORS[r.role] ?? COLORS.textDim;
          return (
            <div key={r.agentId} style={{
              width: 100,
              padding: '12px 8px',
              borderRadius: 8,
              border: `1px solid ${isRevealed ? roleColor : COLORS.border}`,
              background: isRevealed
                ? `linear-gradient(180deg, ${roleColor}15 0%, ${COLORS.bg} 100%)`
                : COLORS.bg,
              textAlign: 'center',
              opacity: isRevealed ? (r.alive ? 1 : 0.5) : 0.3,
              transform: isRevealed ? 'scale(1)' : 'scale(0.85)',
              transition: 'all 0.4s ease',
            }}>
              <div style={{
                fontSize: 24,
                marginBottom: 6,
                filter: r.alive ? 'none' : 'grayscale(0.8)',
              }}>
                {isRevealed ? ROLE_ICONS[r.role] : '?'}
              </div>
              <div style={{
                fontFamily: FONTS.pixel,
                fontSize: 7,
                color: COLORS.text,
                marginBottom: 4,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>
                {r.name}
              </div>
              <div style={{
                fontFamily: FONTS.body,
                fontSize: 11,
                color: isRevealed ? roleColor : 'transparent',
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: 1,
              }}>
                {r.role}
              </div>
              {!r.alive && isRevealed && (
                <div style={{
                  fontFamily: FONTS.body,
                  fontSize: 9,
                  color: COLORS.textDim,
                  marginTop: 2,
                }}>
                  DEAD
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Timeline */}
      {showTimeline && payload.timeline.length > 0 && (
        <div style={{
          width: '100%',
          maxWidth: 700,
          padding: '0 16px',
          marginBottom: 20,
          opacity: showTimeline ? 1 : 0,
          transition: 'opacity 0.5s ease',
        }}>
          <h2 style={{
            fontFamily: FONTS.pixel,
            fontSize: 10,
            color: COLORS.textAccent,
            marginBottom: 12,
            letterSpacing: 2,
          }}>
            TIMELINE
          </h2>
          <div style={{
            maxHeight: 240,
            overflowY: 'auto',
            borderRadius: 6,
            border: `1px solid ${COLORS.border}`,
          }}>
            {payload.timeline.map((entry, i) => (
              <div key={i} style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '8px 12px',
                background: entry.phase === 'night' || entry.phase === 'dawn'
                  ? 'rgba(26,26,46,0.8)'
                  : 'rgba(22,33,62,0.5)',
                borderBottom: i < payload.timeline.length - 1 ? `1px solid ${COLORS.border}` : 'none',
              }}>
                <span style={{ fontSize: 14, flexShrink: 0 }}>
                  {PHASE_ICONS[entry.phase] ?? ''}
                </span>
                <span style={{
                  fontFamily: FONTS.pixel,
                  fontSize: 7,
                  color: COLORS.textDim,
                  flexShrink: 0,
                  width: 50,
                }}>
                  Day {entry.day}
                </span>
                <span style={{
                  fontFamily: FONTS.body,
                  fontSize: 13,
                  color: COLORS.text,
                  flex: 1,
                }}>
                  {entry.event}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Stats bar */}
      {showStats && (
        <div style={{
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'center',
          gap: 12,
          padding: '0 16px 20px',
          opacity: showStats ? 1 : 0,
          transition: 'opacity 0.5s ease',
        }}>
          {[
            { label: 'nights', value: payload.stats.totalDays },
            { label: 'kills', value: payload.stats.totalKills },
            { label: 'saves', value: payload.stats.healerSaves },
            { label: 'correct exiles', value: payload.stats.correctExiles },
            { label: 'wrong exiles', value: payload.stats.wrongExiles },
          ].map(stat => (
            <div key={stat.label} style={{
              padding: '10px 16px',
              borderRadius: 6,
              background: COLORS.bgCard,
              border: `1px solid ${COLORS.border}`,
              textAlign: 'center',
              minWidth: 80,
            }}>
              <div style={{
                fontFamily: FONTS.pixel,
                fontSize: 16,
                color: COLORS.textAccent,
              }}>
                {stat.value}
              </div>
              <div style={{
                fontFamily: FONTS.body,
                fontSize: 11,
                color: COLORS.textDim,
                marginTop: 2,
              }}>
                {stat.label}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Action buttons */}
      {showStats && (
        <div style={{
          display: 'flex',
          gap: 16,
          padding: '12px 16px 32px',
        }}>
          <button
            onClick={onPlayAgain}
            style={{
              fontFamily: FONTS.pixel,
              fontSize: 10,
              padding: '12px 24px',
              background: isVillagersWin ? '#38a169' : '#e53e3e',
              color: '#fff',
              border: 'none',
              borderRadius: 6,
              cursor: 'pointer',
              letterSpacing: 1,
            }}
          >
            PLAY AGAIN
          </button>
          <button
            onClick={onBackToMenu}
            style={{
              fontFamily: FONTS.pixel,
              fontSize: 10,
              padding: '12px 24px',
              background: 'transparent',
              color: COLORS.textDim,
              border: `1px solid ${COLORS.border}`,
              borderRadius: 6,
              cursor: 'pointer',
              letterSpacing: 1,
            }}
          >
            BACK TO MENU
          </button>
        </div>
      )}
    </div>
  );
};
