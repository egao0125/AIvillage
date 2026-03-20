import React from 'react';
import { useWorldEvents, useElections, useWorldTime } from '../../core/hooks';
import type { WorldEvent, Election } from '@ai-village/shared';
import { COLORS, FONTS } from '../styles';

// Event type icons
const EVENT_ICONS: Record<string, string> = {
  storm: '\u26C8\uFE0F',
  festival: '\u{1F389}',
  fire: '\u{1F525}',
  drought: '\u2600\uFE0F',
  harvest: '\u{1F33E}',
  plague: '\u{1F9A0}',
  earthquake: '\u{1F30B}',
  market_boom: '\u{1F4C8}',
  bandit_sighting: '\u{1F5E1}\uFE0F',
  miracle: '\u2728',
};

export const WorldEvents: React.FC = () => {
  const events = useWorldEvents();
  const elections = useElections();
  const time = useWorldTime();

  const activeEvents = events.filter((e) => e.active);
  const activeElections = elections.filter((e) => e.active);

  return (
    <div style={{ padding: 12, fontFamily: FONTS.body, fontSize: '13px', color: COLORS.text }}>
      {/* Active Events */}
      <div style={{ color: COLORS.textAccent, marginBottom: 8, fontSize: '10px', fontFamily: FONTS.pixel }}>WORLD EVENTS</div>
      {activeEvents.length === 0 ? (
        <div style={{ color: COLORS.textDim, fontStyle: 'italic', marginBottom: 16 }}>
          The village is peaceful...
        </div>
      ) : (
        activeEvents.map((event) => {
          const endTime = event.startTime + event.duration * 60_000;
          const remainingMs = endTime - Date.now();
          const remainingMin = Math.max(0, Math.ceil(remainingMs / 60_000));
          return (
            <div
              key={event.id}
              style={{
                background: COLORS.bgCard,
                border: `1px solid ${COLORS.border}`,
                borderRadius: 4,
                padding: 10,
                marginBottom: 8,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <span style={{ fontSize: '14px' }}>{EVENT_ICONS[event.type] || '\u2753'}</span>
                <span style={{ color: '#fff', fontSize: '12px' }}>
                  {event.type
                    .split('_')
                    .map((w: string) => w.charAt(0).toUpperCase() + w.slice(1))
                    .join(' ')}
                </span>
              </div>
              <div style={{ color: COLORS.textDim, lineHeight: '1.6', marginBottom: 4 }}>
                {event.description}
              </div>
              {event.affectedAreas.length > 0 && (
                <div style={{ color: COLORS.textDim, fontSize: '11px' }}>
                  Affected: {event.affectedAreas.join(', ')}
                </div>
              )}
              <div style={{ color: COLORS.accent, fontSize: '11px', marginTop: 4 }}>
                {remainingMin > 0 ? `${remainingMin}m remaining` : 'Ending soon'}
              </div>
            </div>
          );
        })
      )}

      {/* Elections */}
      <div style={{ color: COLORS.textAccent, marginBottom: 8, marginTop: 16, fontSize: '10px', fontFamily: FONTS.pixel }}>
        ELECTIONS
      </div>
      {activeElections.length === 0 ? (
        <div style={{ color: COLORS.textDim, fontStyle: 'italic' }}>No active elections</div>
      ) : (
        activeElections.map((election) => {
          const counts: Record<string, number> = {};
          for (const c of election.candidates) counts[c] = 0;
          for (const v of Object.values(election.votes) as string[]) counts[v] = (counts[v] || 0) + 1;
          const daysLeft = election.endDay - time.day;

          return (
            <div
              key={election.id}
              style={{
                background: COLORS.bgCard,
                border: `1px solid ${COLORS.border}`,
                borderRadius: 4,
                padding: 10,
                marginBottom: 8,
              }}
            >
              <div style={{ color: '#fff', fontSize: '12px', marginBottom: 6, fontFamily: FONTS.pixel }}>
                {'\u{1F5F3}\uFE0F'} {election.position}
              </div>
              {election.candidates.map((c: string) => (
                <div
                  key={c}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    padding: '3px 0',
                    color: COLORS.text,
                  }}
                >
                  <span>{c}</span>
                  <span style={{ color: COLORS.textDim }}>
                    {counts[c] || 0} vote{(counts[c] || 0) !== 1 ? 's' : ''}
                  </span>
                </div>
              ))}
              {election.winner ? (
                <div style={{ color: COLORS.active, marginTop: 4 }}>
                  Winner: {election.winner}
                </div>
              ) : daysLeft > 0 ? (
                <div style={{ color: COLORS.idle, marginTop: 4 }}>
                  {daysLeft} day{daysLeft !== 1 ? 's' : ''} remaining
                </div>
              ) : null}
            </div>
          );
        })
      )}
    </div>
  );
};
