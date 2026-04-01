import React from 'react';
import { COLORS, FONTS } from '../styles';
import { nameToColor, hexToString } from '../../utils/color';
import { gameStore } from '../../core/GameStore';
import { useAgentsMap } from '../../core/hooks';
import type { Agent, MentalModel } from '@ai-village/shared';

function trustColor(trust: number): string {
  if (trust > 130) return '#4ade80';
  if (trust < 70) return '#ef4444';
  return '#fbbf24';
}

const MentalModelCard: React.FC<{ label: string; model: MentalModel | undefined }> = ({ label, model }) => (
  <div style={{ flex: 1, minWidth: 0 }}>
    <div style={{ fontFamily: FONTS.body, fontSize: 11, color: COLORS.textDim, marginBottom: 6 }}>{label}</div>
    {!model ? (
      <div style={{ fontFamily: FONTS.body, fontSize: 11, color: COLORS.textDim, fontStyle: 'italic' }}>No opinion formed</div>
    ) : (
      <div>
        {/* Trust bar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
          <div style={{ flex: 1, height: 6, backgroundColor: COLORS.border, borderRadius: 3, overflow: 'hidden' }}>
            <div style={{
              width: `${(model.trust / 200) * 100}%`,
              height: '100%',
              backgroundColor: trustColor(model.trust),
              borderRadius: 3,
            }} />
          </div>
          <span style={{ fontFamily: FONTS.body, fontSize: 10, color: trustColor(model.trust) }}>{model.trust}</span>
        </div>
        {model.emotionalStance && (
          <div style={{ fontFamily: FONTS.body, fontSize: 11, color: COLORS.text, marginBottom: 2 }}>
            {model.emotionalStance}
          </div>
        )}
        {model.predictedGoal && (
          <div style={{ fontFamily: FONTS.body, fontSize: 11, color: COLORS.textDim, fontStyle: 'italic' }}>
            Goal: {model.predictedGoal}
          </div>
        )}
      </div>
    )}
  </div>
);

const AvatarName: React.FC<{ agent: Agent }> = ({ agent }) => {
  const color = hexToString(nameToColor(agent.config.name));
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{
        width: 40,
        height: 40,
        borderRadius: '50%',
        backgroundColor: color,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#fff',
        fontWeight: 'bold',
        fontSize: 16,
        fontFamily: FONTS.body,
      }}>
        {agent.config.name.charAt(0)}
      </div>
      <div
        style={{ fontFamily: FONTS.pixel, fontSize: 11, color: COLORS.accent, cursor: 'pointer' }}
        onClick={() => gameStore.drillToAgentDetail(agent.id)}
      >
        {agent.config.name}
      </div>
    </div>
  );
};

export const RelationshipDetail: React.FC<{ agentId: string; secondaryId: string }> = ({ agentId, secondaryId }) => {
  const agentsMap = useAgentsMap();
  const agent1 = agentsMap.get(agentId);
  const agent2 = agentsMap.get(secondaryId);

  if (!agent1 || !agent2) {
    return <div style={{ fontFamily: FONTS.body, fontSize: 13, color: COLORS.textDim, padding: 16 }}>Agent not found</div>;
  }

  const model1of2 = agent1.mentalModels?.find((m) => m.targetId === secondaryId);
  const model2of1 = agent2.mentalModels?.find((m) => m.targetId === agentId);

  // Shared ledger entries
  const sharedLedger = (agent1.socialLedger ?? [])
    .filter((e) => e.targetIds.includes(agent2.id))
    .slice(0, 10);

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, padding: '16px 0' }}>
        <AvatarName agent={agent1} />
        <span style={{ fontFamily: FONTS.body, fontSize: 14, color: COLORS.textDim }}>{'<->'}</span>
        <AvatarName agent={agent2} />
      </div>

      {/* Side-by-side mental models */}
      <div style={{ display: 'flex', gap: 12, padding: '8px 0' }}>
        <MentalModelCard label={`${agent1.config.name}'s view`} model={model1of2} />
        <MentalModelCard label={`${agent2.config.name}'s view`} model={model2of1} />
      </div>

      {/* Shared ledger */}
      <div style={{ padding: '16px 0' }}>
        <div style={{ fontFamily: FONTS.pixel, fontSize: 8, color: COLORS.textDim, letterSpacing: 2, marginBottom: 8 }}>
          SHARED HISTORY
        </div>
        {sharedLedger.length === 0 ? (
          <div style={{ fontFamily: FONTS.body, fontSize: 12, color: COLORS.textDim }}>No shared history yet</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {sharedLedger.map((entry) => (
              <div key={entry.id} style={{ backgroundColor: COLORS.bgCard, borderRadius: 4, padding: 8 }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4 }}>
                  <span style={{
                    fontFamily: FONTS.body,
                    fontSize: 10,
                    color: COLORS.accent,
                    backgroundColor: COLORS.accent + '22',
                    padding: '1px 6px',
                    borderRadius: 3,
                    textTransform: 'capitalize',
                  }}>
                    {entry.type}
                  </span>
                  <span style={{
                    fontFamily: FONTS.body,
                    fontSize: 10,
                    color: entry.status === 'fulfilled' ? '#4ade80' : entry.status === 'broken' ? '#ef4444' : COLORS.textDim,
                    textTransform: 'capitalize',
                  }}>
                    {entry.status}
                  </span>
                  <span style={{ fontFamily: FONTS.body, fontSize: 10, color: COLORS.textDim, marginLeft: 'auto' }}>
                    Day {entry.day}
                  </span>
                </div>
                <div style={{ fontFamily: FONTS.body, fontSize: 11, color: COLORS.text }}>
                  {entry.description}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
