import React, { useState, useCallback } from 'react';
import { useEventFeed, useChatLog } from '../../core/hooks';
import { EventCard } from './EventCard';
import { EVENT_BADGES } from './types';
import type { EventType } from './types';
import { COLORS, FONTS } from '../styles';

export const EventFeed: React.FC = () => {
  const events = useEventFeed();
  const chatLog = useChatLog();
  const [filterType, setFilterType] = useState<EventType | null>(null);

  const filtered = filterType ? events.filter(e => e.type === filterType) : events;

  // Collect types that actually exist in the feed
  const typeCounts = new Map<EventType, number>();
  for (const e of events) {
    typeCounts.set(e.type, (typeCounts.get(e.type) ?? 0) + 1);
  }
  const availableTypes = Array.from(typeCounts.keys()).sort();

  if (events.length === 0) {
    return (
      <div style={{ padding: 20, textAlign: 'center', color: COLORS.textDim, fontFamily: FONTS.body, fontSize: '13px' }}>
        No village events yet.
        <br />
        <span style={{ fontSize: '11px', marginTop: 8, display: 'block' }}>
          Activity will appear as agents interact.
        </span>
      </div>
    );
  }

  return (
    <div style={{ padding: '4px 0' }}>
      {/* Filter bar */}
      {availableTypes.length > 1 && (
        <div style={{
          padding: '8px 10px',
          display: 'flex',
          gap: 6,
          flexWrap: 'wrap',
          borderBottom: `1px solid ${COLORS.border}`,
        }}>
          <button
            onClick={() => setFilterType(null)}
            style={{
              fontFamily: FONTS.pixel,
              fontSize: '9px',
              padding: '5px 10px',
              borderRadius: 4,
              border: `1px solid ${filterType === null ? COLORS.accent : COLORS.border}`,
              background: filterType === null ? COLORS.accentDim : 'transparent',
              color: filterType === null ? COLORS.accent : COLORS.textDim,
              cursor: 'pointer',
              textTransform: 'uppercase',
            }}
          >
            All ({events.length})
          </button>
          {availableTypes.map(type => {
            const b = EVENT_BADGES[type];
            const count = typeCounts.get(type) ?? 0;
            return (
              <button
                key={type}
                onClick={() => setFilterType(filterType === type ? null : type)}
                style={{
                  fontFamily: FONTS.pixel,
                  fontSize: '9px',
                  padding: '5px 10px',
                  borderRadius: 4,
                  border: `1px solid ${filterType === type ? b.color : COLORS.border}`,
                  background: filterType === type ? b.color + '22' : 'transparent',
                  color: filterType === type ? b.color : COLORS.textDim,
                  cursor: 'pointer',
                  textTransform: 'uppercase',
                }}
              >
                {b.icon} {type} ({count})
              </button>
            );
          })}
        </div>
      )}

      {/* Event cards */}
      {filtered.map(event => (
        <EventCard key={event.id} event={event} chatLog={chatLog} />
      ))}
    </div>
  );
};
