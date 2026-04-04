import React from 'react';
import { FONTS } from '../styles';
import { useTheme } from '../ThemeContext';
import { useInstitutions, useAgentsMap } from '../../core/hooks';
import { gameStore } from '../../core/GameStore';

export const InstitutionsPanel: React.FC = () => {
  const { colors } = useTheme();

  const clickableName: React.CSSProperties = {
    fontFamily: FONTS.body,
    fontSize: 11,
    color: colors.accent,
    cursor: 'pointer',
  };
  const institutions = useInstitutions();
  const agentsMap = useAgentsMap();

  const agentName = (id: string): string =>
    agentsMap.get(id)?.config.name ?? id.slice(0, 8);

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
        INSTITUTIONS
      </div>

      {institutions.length === 0 ? (
        <div style={{ fontFamily: FONTS.body, fontSize: 11, color: colors.textDim }}>
          No institutions formed yet.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {institutions.map((inst) => (
            <div
              key={inst.id}
              onClick={() => gameStore.openDetail({ type: 'institution', id: inst.id })}
              style={{
                background: colors.bgCard,
                border: `1px solid ${colors.border}`,
                borderRadius: 4,
                padding: 10,
                cursor: 'pointer',
                opacity: inst.dissolved ? 0.5 : 1,
              }}
            >
              {/* Header: Name + type badge */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                <span style={{ fontFamily: FONTS.pixel, fontSize: 9, color: colors.text }}>
                  {inst.name}
                </span>
                <span
                  style={{
                    fontFamily: FONTS.pixel,
                    fontSize: 6,
                    color: colors.bgCard,
                    background: colors.accent,
                    padding: '1px 5px',
                    borderRadius: 6,
                    textTransform: 'uppercase',
                  }}
                >
                  {inst.type}
                </span>
                {inst.dissolved && (
                  <span
                    style={{
                      fontFamily: FONTS.pixel,
                      fontSize: 6,
                      color: '#fff',
                      background: colors.warning,
                      padding: '1px 5px',
                      borderRadius: 6,
                      textTransform: 'uppercase',
                    }}
                  >
                    Dissolved
                  </span>
                )}
              </div>

              {/* Founder */}
              <div style={{ marginBottom: 4 }}>
                <span style={{ fontFamily: FONTS.pixel, fontSize: 6, color: colors.textDim }}>
                  Founder:{' '}
                </span>
                <span
                  style={clickableName}
                  onClick={(e) => {
                    e.stopPropagation();
                    gameStore.openAgentDetail(inst.founderId);
                  }}
                >
                  {agentName(inst.founderId)}
                </span>
              </div>

              {/* Members + Treasury */}
              <div style={{ display: 'flex', gap: 12, marginBottom: 4 }}>
                <span style={{ fontFamily: FONTS.body, fontSize: 10, color: colors.textDim }}>
                  Members: {inst.members.length}
                </span>
                <span style={{ fontFamily: FONTS.body, fontSize: 10, color: colors.gold }}>
                  Treasury: {inst.treasury}
                </span>
              </div>

              {/* Rules — truncated */}
              {inst.rules.length > 0 && (
                <div style={{ marginTop: 4 }}>
                  <div style={{ fontFamily: FONTS.pixel, fontSize: 6, color: colors.textDim, marginBottom: 2 }}>
                    Rules ({inst.rules.length}):
                  </div>
                  {inst.rules.slice(0, 2).map((rule, i) => (
                    <div
                      key={i}
                      style={{
                        fontFamily: FONTS.body,
                        fontSize: 10,
                        color: colors.text,
                        paddingLeft: 8,
                        lineHeight: 1.4,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      - {rule}
                    </div>
                  ))}
                  {inst.rules.length > 2 && (
                    <div style={{ fontFamily: FONTS.body, fontSize: 10, color: colors.textDim, paddingLeft: 8 }}>
                      +{inst.rules.length - 2} more
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
