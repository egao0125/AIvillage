import React from 'react';
import type { Agent } from '@ai-village/shared';
import { COLORS, FONTS } from '../styles';
import { nameToColor, hexToString } from '../../utils/color';
import { gameStore } from '../../core/GameStore';
import { useAgentsMap } from '../../core/hooks';

function trustColor(trust: number): string {
  if (trust > 130) return '#4ade80';
  if (trust < 70) return '#ef4444';
  return '#fbbf24';
}

export const Relationships: React.FC<{ agent: Agent }> = ({ agent }) => {
  const agentsMap = useAgentsMap();
  const models = agent.mentalModels;

  return (
    <div style={{ padding: '8px 0' }}>
      <div style={{ fontFamily: FONTS.pixel, fontSize: 8, color: COLORS.textDim, letterSpacing: 2, marginBottom: 8 }}>
        RELATIONSHIPS
      </div>

      {!models || models.length === 0 ? (
        <div style={{ fontFamily: FONTS.body, fontSize: 12, color: COLORS.textDim }}>
          No known relationships yet
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {models.map((model) => {
            const target = agentsMap.get(model.targetId);
            const targetName = target?.config.name ?? 'Unknown';
            const color = hexToString(nameToColor(targetName));

            return (
              <div key={model.targetId} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {/* Mini avatar */}
                <div style={{
                  width: 28,
                  height: 28,
                  borderRadius: '50%',
                  backgroundColor: color,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#fff',
                  fontSize: 12,
                  fontWeight: 'bold',
                  fontFamily: FONTS.body,
                  flexShrink: 0,
                }}>
                  {targetName.charAt(0)}
                </div>

                <div style={{ flex: 1, minWidth: 0 }}>
                  {/* Name - clickable */}
                  <div
                    style={{ fontFamily: FONTS.body, fontSize: 12, color: COLORS.accent, cursor: 'pointer' }}
                    onClick={() => gameStore.drillToAgentDetail(model.targetId)}
                  >
                    {targetName}
                  </div>

                  {/* Trust bar */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
                    <div style={{ flex: 1, height: 4, backgroundColor: COLORS.border, borderRadius: 2, overflow: 'hidden' }}>
                      <div style={{
                        width: `${(model.trust / 200) * 100}%`,
                        height: '100%',
                        backgroundColor: trustColor(model.trust),
                        borderRadius: 2,
                        transition: 'width 0.3s ease',
                      }} />
                    </div>
                    <span style={{ fontFamily: FONTS.body, fontSize: 10, color: trustColor(model.trust), minWidth: 24, textAlign: 'right' }}>
                      {model.trust}
                    </span>
                  </div>

                  {/* Emotional stance */}
                  {model.emotionalStance && (
                    <div style={{ fontFamily: FONTS.body, fontSize: 11, color: COLORS.textDim, marginTop: 2 }}>
                      {model.emotionalStance}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
