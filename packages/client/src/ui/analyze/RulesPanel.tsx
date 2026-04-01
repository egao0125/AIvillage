import React, { useMemo } from 'react';
import { COLORS, FONTS } from '../styles';
import { useBoard, useAgentsMap } from '../../core/hooks';
import { gameStore } from '../../core/GameStore';

export const RulesPanel: React.FC = () => {
  const board = useBoard();
  const agentsMap = useAgentsMap();

  const agentName = (id: string): string =>
    agentsMap.get(id)?.config.name ?? id.slice(0, 8);

  const rules = useMemo(
    () =>
      board.filter(
        (p) => p.type === 'rule' && p.ruleStatus === 'passed' && !p.revoked
      ),
    [board]
  );

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
        VILLAGE RULES
      </div>

      {rules.length === 0 ? (
        <div style={{ fontFamily: FONTS.body, fontSize: 11, color: COLORS.textDim }}>
          No rules passed yet.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {rules.map((rule) => {
            const likes = rule.votes?.filter((v) => v.vote === 'like').length ?? 0;
            const dislikes = rule.votes?.filter((v) => v.vote === 'dislike').length ?? 0;

            return (
              <div
                key={rule.id}
                style={{
                  background: COLORS.bgCard,
                  border: `1px solid ${COLORS.border}`,
                  borderRadius: 4,
                  padding: 10,
                }}
              >
                <div
                  style={{
                    fontFamily: FONTS.body,
                    fontSize: 11,
                    color: COLORS.text,
                    lineHeight: 1.4,
                    marginBottom: 6,
                  }}
                >
                  {rule.content}
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span
                    style={{
                      fontFamily: FONTS.body,
                      fontSize: 10,
                      color: COLORS.accent,
                      cursor: 'pointer',
                    }}
                    onClick={() => gameStore.inspectAgent(rule.authorId)}
                  >
                    {agentName(rule.authorId)}
                  </span>

                  <span style={{ fontFamily: FONTS.pixel, fontSize: 6, color: COLORS.textDim }}>
                    Day {rule.day}
                  </span>

                  {rule.votes && rule.votes.length > 0 && (
                    <span style={{ fontFamily: FONTS.body, fontSize: 10, color: COLORS.textDim, marginLeft: 'auto' }}>
                      <span style={{ color: COLORS.active }}>{likes}</span>
                      {' / '}
                      <span style={{ color: COLORS.warning }}>{dislikes}</span>
                    </span>
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
