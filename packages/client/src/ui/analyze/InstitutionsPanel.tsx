import React from 'react';
import { COLORS, FONTS } from '../styles';
import { useInstitutions, useAgentsMap } from '../../core/hooks';
import { gameStore } from '../../core/GameStore';

const clickableName: React.CSSProperties = {
  fontFamily: FONTS.body,
  fontSize: 11,
  color: COLORS.accent,
  cursor: 'pointer',
};

export const InstitutionsPanel: React.FC = () => {
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
          color: COLORS.textDim,
          marginBottom: 10,
          letterSpacing: 1,
        }}
      >
        INSTITUTIONS
      </div>

      {institutions.length === 0 ? (
        <div style={{ fontFamily: FONTS.body, fontSize: 11, color: COLORS.textDim }}>
          No institutions formed yet.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {institutions.map((inst) => (
            <div
              key={inst.id}
              onClick={() => gameStore.openDetail({ type: 'institution', id: inst.id })}
              style={{
                background: COLORS.bgCard,
                border: `1px solid ${COLORS.border}`,
                borderRadius: 4,
                padding: 10,
                cursor: 'pointer',
                opacity: inst.dissolved ? 0.5 : 1,
              }}
            >
              {/* Header: Name + type badge */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                <span style={{ fontFamily: FONTS.pixel, fontSize: 9, color: COLORS.text }}>
                  {inst.name}
                </span>
                <span
                  style={{
                    fontFamily: FONTS.pixel,
                    fontSize: 6,
                    color: COLORS.bgCard,
                    background: COLORS.accent,
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
                      background: COLORS.warning,
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
                <span style={{ fontFamily: FONTS.pixel, fontSize: 6, color: COLORS.textDim }}>
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
                <span style={{ fontFamily: FONTS.body, fontSize: 10, color: COLORS.textDim }}>
                  Members: {inst.members.length}
                </span>
                <span style={{ fontFamily: FONTS.body, fontSize: 10, color: COLORS.gold }}>
                  Treasury: {inst.treasury}
                </span>
              </div>

              {/* Rules — truncated */}
              {inst.rules.length > 0 && (
                <div style={{ marginTop: 4 }}>
                  <div style={{ fontFamily: FONTS.pixel, fontSize: 6, color: COLORS.textDim, marginBottom: 2 }}>
                    Rules ({inst.rules.length}):
                  </div>
                  {inst.rules.slice(0, 2).map((rule, i) => (
                    <div
                      key={i}
                      style={{
                        fontFamily: FONTS.body,
                        fontSize: 10,
                        color: COLORS.text,
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
                    <div style={{ fontFamily: FONTS.body, fontSize: 10, color: COLORS.textDim, paddingLeft: 8 }}>
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
