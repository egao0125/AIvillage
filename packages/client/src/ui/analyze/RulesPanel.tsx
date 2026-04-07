import React, { useMemo } from 'react';
import { FONTS } from '../styles';
import { useTheme } from '../ThemeContext';
import { useBoard, useAgentsMap } from '../../core/hooks';
import { gameStore } from '../../core/GameStore';

export const RulesPanel: React.FC = () => {
  const { colors } = useTheme();
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
          color: colors.textDim,
          marginBottom: 10,
          letterSpacing: 1,
        }}
      >
        VILLAGE RULES
      </div>

      {rules.length === 0 ? (
        <div style={{ fontFamily: FONTS.body, fontSize: 11, color: colors.textDim }}>
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
                  background: colors.bgCard,
                  border: `1px solid ${colors.border}`,
                  borderRadius: 4,
                  padding: 10,
                }}
              >
                <div
                  style={{
                    fontFamily: FONTS.body,
                    fontSize: 11,
                    color: colors.text,
                    lineHeight: 1.4,
                    marginBottom: 6,
                  }}
                >
                  {rule.ruleAction || rule.content}
                </div>

                {(rule.ruleAppliesTo || rule.ruleConsequence) && (
                  <div style={{ marginBottom: 6, display: 'flex', flexDirection: 'column', gap: 2 }}>
                    {rule.ruleAppliesTo && (
                      <div style={{ fontFamily: FONTS.body, fontSize: 10, color: colors.textDim }}>
                        <span style={{ color: colors.accent }}>Applies to:</span> {rule.ruleAppliesTo}
                      </div>
                    )}
                    {rule.ruleConsequence && (
                      <div style={{ fontFamily: FONTS.body, fontSize: 10, color: colors.textDim }}>
                        <span style={{ color: colors.warning }}>Consequence:</span> {rule.ruleConsequence}
                      </div>
                    )}
                  </div>
                )}

                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span
                    style={{
                      fontFamily: FONTS.body,
                      fontSize: 10,
                      color: colors.accent,
                      cursor: 'pointer',
                    }}
                    onClick={() => gameStore.openAgentDetail(rule.authorId)}
                  >
                    {agentName(rule.authorId)}
                  </span>

                  <span style={{ fontFamily: FONTS.pixel, fontSize: 6, color: colors.textDim }}>
                    Day {rule.day}
                  </span>

                  {rule.votes && rule.votes.length > 0 && (
                    <span style={{ fontFamily: FONTS.body, fontSize: 10, color: colors.textDim, marginLeft: 'auto' }}>
                      <span style={{ color: colors.active }}>{likes}</span>
                      {' / '}
                      <span style={{ color: colors.warning }}>{dislikes}</span>
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
