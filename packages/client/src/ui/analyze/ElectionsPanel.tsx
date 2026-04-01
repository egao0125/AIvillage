import React, { useMemo } from 'react';
import { COLORS, FONTS } from '../styles';
import { useElections, useAgentsMap, useWorldTime } from '../../core/hooks';
import { gameStore } from '../../core/GameStore';

const clickableName: React.CSSProperties = {
  fontFamily: FONTS.body,
  fontSize: 11,
  color: COLORS.accent,
  cursor: 'pointer',
  textDecoration: 'none',
};

export const ElectionsPanel: React.FC = () => {
  const elections = useElections();
  const agentsMap = useAgentsMap();
  const time = useWorldTime();

  const agentName = (id: string): string =>
    agentsMap.get(id)?.config.name ?? id.slice(0, 8);

  const active = useMemo(
    () => elections.filter((e) => e.active),
    [elections]
  );

  const past = useMemo(
    () =>
      elections
        .filter((e) => !e.active)
        .sort((a, b) => b.endDay - a.endDay)
        .slice(0, 5),
    [elections]
  );

  const voteCounts = (election: typeof elections[0]) => {
    const counts: Record<string, number> = {};
    for (const c of election.candidates) counts[c] = 0;
    for (const votedFor of Object.values(election.votes)) {
      counts[votedFor] = (counts[votedFor] ?? 0) + 1;
    }
    return counts;
  };

  return (
    <div>
      <div
        style={{
          fontFamily: FONTS.pixel,
          fontSize: 8,
          color: COLORS.textDim,
          marginBottom: 10,
          letterSpacing: 1,
        }}
      >
        ELECTIONS
      </div>

      {elections.length === 0 ? (
        <div style={{ fontFamily: FONTS.body, fontSize: 11, color: COLORS.textDim }}>
          No elections held yet.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {/* Active Elections */}
          {active.map((el) => {
            const counts = voteCounts(el);
            const daysLeft = el.endDay - time.day;
            return (
              <div
                key={el.id}
                style={{
                  background: COLORS.bgCard,
                  border: `1px solid ${COLORS.accent}`,
                  borderRadius: 4,
                  padding: 10,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <span style={{ fontFamily: FONTS.pixel, fontSize: 8, color: COLORS.accent }}>
                    {el.position}
                  </span>
                  <span style={{ fontFamily: FONTS.pixel, fontSize: 6, color: COLORS.gold }}>
                    {daysLeft > 0 ? `${daysLeft}d left` : 'Ending today'}
                  </span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {el.candidates.map((cId) => (
                    <div
                      key={cId}
                      style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                    >
                      <span
                        style={clickableName}
                        onClick={() => gameStore.openAgentDetail(cId)}
                      >
                        {agentName(cId)}
                      </span>
                      <span style={{ fontFamily: FONTS.pixel, fontSize: 8, color: COLORS.text }}>
                        {counts[cId] ?? 0} votes
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}

          {/* Past Elections */}
          {past.map((el) => {
            const counts = voteCounts(el);
            return (
              <div
                key={el.id}
                style={{
                  background: COLORS.bgCard,
                  border: `1px solid ${COLORS.border}`,
                  borderRadius: 4,
                  padding: 10,
                  opacity: 0.8,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                  <span style={{ fontFamily: FONTS.pixel, fontSize: 8, color: COLORS.textDim }}>
                    {el.position}
                  </span>
                  <span style={{ fontFamily: FONTS.pixel, fontSize: 6, color: COLORS.textDim }}>
                    Day {el.endDay}
                  </span>
                </div>
                {el.winner && (
                  <div style={{ marginBottom: 4 }}>
                    <span style={{ fontFamily: FONTS.pixel, fontSize: 6, color: COLORS.textDim }}>Winner: </span>
                    <span
                      style={clickableName}
                      onClick={() => gameStore.openAgentDetail(el.winner!)}
                    >
                      {agentName(el.winner)}
                    </span>
                  </div>
                )}
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {el.candidates.map((cId) => (
                    <span key={cId} style={{ fontFamily: FONTS.body, fontSize: 10, color: COLORS.textDim }}>
                      {agentName(cId)}: {counts[cId] ?? 0}
                    </span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
