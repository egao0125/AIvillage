import React, { useMemo } from 'react';
import { FONTS } from '../styles';
import { useTheme } from '../ThemeContext';
import { useElections, useAgentsMap, useWorldTime } from '../../core/hooks';
import { gameStore } from '../../core/GameStore';

export const ElectionsPanel: React.FC = () => {
  const { colors } = useTheme();

  const clickableName: React.CSSProperties = {
    fontFamily: FONTS.body,
    fontSize: 11,
    color: colors.accent,
    cursor: 'pointer',
    textDecoration: 'none',
  };
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
          color: colors.textDim,
          marginBottom: 10,
          letterSpacing: 1,
        }}
      >
        ELECTIONS
      </div>

      {elections.length === 0 ? (
        <div style={{ fontFamily: FONTS.body, fontSize: 11, color: colors.textDim }}>
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
                  background: colors.bgCard,
                  border: `1px solid ${colors.accent}`,
                  borderRadius: 4,
                  padding: 10,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <span style={{ fontFamily: FONTS.pixel, fontSize: 8, color: colors.accent }}>
                    {el.position}
                  </span>
                  <span style={{ fontFamily: FONTS.pixel, fontSize: 6, color: colors.gold }}>
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
                      <span style={{ fontFamily: FONTS.pixel, fontSize: 8, color: colors.text }}>
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
                  background: colors.bgCard,
                  border: `1px solid ${colors.border}`,
                  borderRadius: 4,
                  padding: 10,
                  opacity: 0.8,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                  <span style={{ fontFamily: FONTS.pixel, fontSize: 8, color: colors.textDim }}>
                    {el.position}
                  </span>
                  <span style={{ fontFamily: FONTS.pixel, fontSize: 6, color: colors.textDim }}>
                    Day {el.endDay}
                  </span>
                </div>
                {el.winner && (
                  <div style={{ marginBottom: 4 }}>
                    <span style={{ fontFamily: FONTS.pixel, fontSize: 6, color: colors.textDim }}>Winner: </span>
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
                    <span key={cId} style={{ fontFamily: FONTS.body, fontSize: 10, color: colors.textDim }}>
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
