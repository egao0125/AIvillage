import React from 'react';
import { COLORS, FONTS } from '../styles';
import type { LayoutMode, SocialFilter } from './types';
import type { SocialPrimitiveType } from '@ai-village/shared';

const TYPE_INFO: { type: SocialPrimitiveType; tooltip: string }[] = [
  { type: 'trade', tooltip: 'Resource exchanges between agents' },
  { type: 'promise', tooltip: 'Verbal commitments or agreements' },
  { type: 'meeting', tooltip: 'Conversations or gatherings' },
  { type: 'task', tooltip: 'Collaborative work or assigned jobs' },
  { type: 'rule', tooltip: 'Shared rules or institutional agreements' },
  { type: 'alliance', tooltip: 'Formal alliances or faction membership' },
];

interface SocialControlsProps {
  layout: LayoutMode;
  onLayoutChange: (mode: LayoutMode) => void;
  filter: SocialFilter;
  onFilterChange: (filter: SocialFilter) => void;
}

export const SocialControls: React.FC<SocialControlsProps> = ({
  layout, onLayoutChange, filter, onFilterChange,
}) => {
  const toggleType = (type: SocialPrimitiveType) => {
    const next = new Set(filter.types);
    if (next.has(type)) {
      next.delete(type);
    } else {
      next.add(type);
    }
    onFilterChange({ ...filter, types: next });
  };

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '8px 16px',
        flexWrap: 'wrap',
      }}
    >
      {/* Layout toggle */}
      <div style={{ display: 'flex', background: COLORS.bgCard, borderRadius: 4, overflow: 'hidden' }}>
        <button
          onClick={() => onLayoutChange('force')}
          title="Auto-arrange nodes by relationship strength"
          style={{
            padding: '4px 12px',
            border: 'none',
            cursor: 'pointer',
            background: layout === 'force' ? COLORS.accent : 'transparent',
            color: layout === 'force' ? COLORS.bg : COLORS.textDim,
            fontFamily: FONTS.pixel,
            fontSize: 8,
            textTransform: 'uppercase',
          }}
        >
          force
        </button>
        <button
          onClick={() => onLayoutChange('map')}
          title="Position agents by their village location"
          style={{
            padding: '4px 12px',
            border: 'none',
            cursor: 'pointer',
            background: layout === 'map' ? COLORS.accent : 'transparent',
            color: layout === 'map' ? COLORS.bg : COLORS.textDim,
            fontFamily: FONTS.pixel,
            fontSize: 8,
            textTransform: 'uppercase',
          }}
        >
          map
        </button>
      </div>

      {/* Separator */}
      <div style={{ width: 1, height: 20, background: COLORS.border }} />

      {/* Type filters */}
      {TYPE_INFO.map(({ type, tooltip }) => (
        <button
          key={type}
          onClick={() => toggleType(type)}
          title={tooltip}
          style={{
            padding: '3px 8px',
            border: `1px solid ${filter.types.has(type) ? COLORS.accent : COLORS.border}`,
            borderRadius: 3,
            background: filter.types.has(type) ? `${COLORS.accent}20` : 'transparent',
            color: filter.types.has(type) ? COLORS.textAccent : COLORS.textDim,
            cursor: 'pointer',
            fontFamily: FONTS.body,
            fontSize: 10,
            textTransform: 'capitalize',
          }}
        >
          {type}
        </button>
      ))}

      {/* Separator */}
      <div style={{ width: 1, height: 20, background: COLORS.border }} />

      {/* Active only toggle */}
      <button
        onClick={() => onFilterChange({ ...filter, activeOnly: !filter.activeOnly })}
        title="Show only relationships with pending or active interactions"
        style={{
          padding: '3px 8px',
          border: `1px solid ${filter.activeOnly ? COLORS.accent : COLORS.border}`,
          borderRadius: 3,
          background: filter.activeOnly ? `${COLORS.accent}20` : 'transparent',
          color: filter.activeOnly ? COLORS.textAccent : COLORS.textDim,
          cursor: 'pointer',
          fontFamily: FONTS.body,
          fontSize: 10,
        }}
      >
        Active Only
      </button>

      {/* Disagreements only toggle */}
      <button
        onClick={() => onFilterChange({ ...filter, disagreementsOnly: !filter.disagreementsOnly })}
        title="Show only relationships where agents disagree on what happened"
        style={{
          padding: '3px 8px',
          border: `1px solid ${filter.disagreementsOnly ? COLORS.warning : COLORS.border}`,
          borderRadius: 3,
          background: filter.disagreementsOnly ? 'rgba(255,107,107,0.15)' : 'transparent',
          color: filter.disagreementsOnly ? COLORS.warning : COLORS.textDim,
          cursor: 'pointer',
          fontFamily: FONTS.body,
          fontSize: 10,
        }}
      >
        Disagreements
      </button>

      {/* Separator */}
      <div style={{ width: 1, height: 20, background: COLORS.border }} />

      {/* Search */}
      <input
        type="text"
        placeholder="Search agents..."
        value={filter.searchQuery}
        onChange={e => onFilterChange({ ...filter, searchQuery: e.target.value })}
        style={{
          padding: '4px 10px',
          border: `1px solid ${COLORS.border}`,
          borderRadius: 4,
          background: COLORS.bgCard,
          color: COLORS.text,
          fontFamily: FONTS.body,
          fontSize: 11,
          width: 140,
          outline: 'none',
        }}
      />
    </div>
  );
};
