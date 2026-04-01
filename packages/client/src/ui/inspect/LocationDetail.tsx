import React from 'react';
import { COLORS, FONTS } from '../styles';
import { gameStore } from '../../core/GameStore';
import { useBuildings, useAgentsMap } from '../../core/hooks';

export const LocationDetail: React.FC<{ locationId: string }> = ({ locationId }) => {
  const buildings = useBuildings();
  const agentsMap = useAgentsMap();

  const building = buildings.find((b) => b.id === locationId);

  if (!building) {
    return <div style={{ fontFamily: FONTS.body, fontSize: 13, color: COLORS.textDim, padding: 16 }}>Location not found</div>;
  }

  const owner = building.ownerId ? agentsMap.get(building.ownerId) : null;

  return (
    <div>
      {/* Name + type */}
      <div style={{ padding: '16px 0 8px' }}>
        <div style={{ fontFamily: FONTS.pixel, fontSize: 12, color: COLORS.text }}>{building.name}</div>
        <div style={{ fontFamily: FONTS.body, fontSize: 11, color: COLORS.textDim, textTransform: 'capitalize', marginTop: 4 }}>
          {building.type}
        </div>
      </div>

      {/* Description */}
      {building.description && (
        <div style={{ fontFamily: FONTS.body, fontSize: 12, color: COLORS.textDim, lineHeight: 1.5, padding: '4px 0 12px' }}>
          {building.description}
        </div>
      )}

      {/* Owner */}
      {owner && (
        <div style={{ padding: '4px 0' }}>
          <span style={{ fontFamily: FONTS.body, fontSize: 11, color: COLORS.textDim }}>Owner: </span>
          <span
            style={{ fontFamily: FONTS.body, fontSize: 11, color: COLORS.accent, cursor: 'pointer' }}
            onClick={() => gameStore.inspectAgent(owner.id)}
          >
            {owner.config.name}
          </span>
        </div>
      )}

      {/* Durability */}
      <div style={{ padding: '8px 0' }}>
        <div style={{ fontFamily: FONTS.body, fontSize: 11, color: COLORS.textDim, marginBottom: 4 }}>Durability</div>
        <div style={{ height: 6, backgroundColor: COLORS.border, borderRadius: 3, overflow: 'hidden' }}>
          <div style={{
            width: `${Math.min(100, building.durability)}%`,
            height: '100%',
            backgroundColor: building.durability > 50 ? '#4ade80' : building.durability > 20 ? '#fbbf24' : '#ef4444',
            borderRadius: 3,
          }} />
        </div>
        <div style={{ fontFamily: FONTS.body, fontSize: 10, color: COLORS.textDim, marginTop: 2 }}>{building.durability}%</div>
      </div>

      {/* Who's Here */}
      <div style={{ padding: '12px 0' }}>
        <div style={{ fontFamily: FONTS.pixel, fontSize: 8, color: COLORS.textDim, letterSpacing: 2, marginBottom: 8 }}>
          {"WHO'S HERE"}
        </div>
        <div style={{ fontFamily: FONTS.body, fontSize: 11, color: COLORS.textDim, fontStyle: 'italic' }}>
          Agent positions do not yet map to buildings.
        </div>
      </div>
    </div>
  );
};
