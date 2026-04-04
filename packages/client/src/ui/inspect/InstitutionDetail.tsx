import React from 'react';
import { FONTS } from '../styles';
import { useTheme } from '../ThemeContext';
import { nameToColor, hexToString } from '../../utils/color';
import { gameStore } from '../../core/GameStore';
import { useInstitutions, useAgentsMap } from '../../core/hooks';
import { GroupChat } from './GroupChat';

export const InstitutionDetail: React.FC<{ institutionId: string }> = ({ institutionId }) => {
  const { colors } = useTheme();
  const institutions = useInstitutions();
  const agentsMap = useAgentsMap();

  const institution = institutions.find((i) => i.id === institutionId);

  if (!institution) {
    return <div style={{ fontFamily: FONTS.body, fontSize: 13, color: colors.textDim, padding: 16 }}>Institution not found</div>;
  }

  const founder = agentsMap.get(institution.founderId);
  const memberIds = institution.members.map((m) => m.agentId);

  return (
    <div>
      {/* Name + type + dissolved badge */}
      <div style={{ padding: '16px 0 8px', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ fontFamily: FONTS.pixel, fontSize: 12, color: colors.text }}>{institution.name}</div>
        <span style={{
          fontFamily: FONTS.body,
          fontSize: 10,
          color: colors.accent,
          backgroundColor: colors.accent + '22',
          padding: '2px 8px',
          borderRadius: 3,
          textTransform: 'capitalize',
        }}>
          {institution.type}
        </span>
        {institution.dissolved && (
          <span style={{
            fontFamily: FONTS.body,
            fontSize: 10,
            color: colors.warning,
            backgroundColor: colors.warning + '22',
            padding: '2px 8px',
            borderRadius: 3,
          }}>
            DISSOLVED
          </span>
        )}
      </div>

      {/* Description */}
      {institution.description && (
        <div style={{ fontFamily: FONTS.body, fontSize: 12, color: colors.textDim, lineHeight: 1.5, padding: '4px 0 12px' }}>
          {institution.description}
        </div>
      )}

      {/* Founder */}
      {founder && (
        <div style={{ padding: '4px 0' }}>
          <span style={{ fontFamily: FONTS.body, fontSize: 11, color: colors.textDim }}>Founded by: </span>
          <span
            style={{ fontFamily: FONTS.body, fontSize: 11, color: colors.accent, cursor: 'pointer' }}
            onClick={() => gameStore.drillToAgentDetail(founder.id)}
          >
            {founder.config.name}
          </span>
        </div>
      )}

      {/* Treasury */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 0', fontFamily: FONTS.body, fontSize: 12, color: colors.gold }}>
        <span>{'🪙'}</span>
        <span>Treasury: {institution.treasury}</span>
      </div>

      {/* Rules */}
      {institution.rules.length > 0 && (
        <div style={{ padding: '8px 0' }}>
          <div style={{ fontFamily: FONTS.pixel, fontSize: 8, color: colors.textDim, letterSpacing: 2, marginBottom: 8 }}>
            RULES
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {institution.rules.map((rule, i) => (
              <div key={i} style={{
                fontFamily: FONTS.body,
                fontSize: 11,
                color: colors.text,
                backgroundColor: colors.bgCard,
                padding: '6px 8px',
                borderRadius: 3,
              }}>
                {rule}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Members */}
      <div style={{ padding: '8px 0' }}>
        <div style={{ fontFamily: FONTS.pixel, fontSize: 8, color: colors.textDim, letterSpacing: 2, marginBottom: 8 }}>
          MEMBERS ({institution.members.length})
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {institution.members.map((member) => {
            const agent = agentsMap.get(member.agentId);
            const name = agent?.config.name ?? 'Unknown';
            const color = hexToString(nameToColor(name));
            return (
              <div key={member.agentId} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{
                  width: 24,
                  height: 24,
                  borderRadius: '50%',
                  backgroundColor: color,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#fff',
                  fontSize: 10,
                  fontWeight: 'bold',
                  fontFamily: FONTS.body,
                  flexShrink: 0,
                }}>
                  {name.charAt(0)}
                </div>
                <span
                  style={{ fontFamily: FONTS.body, fontSize: 11, color: colors.accent, cursor: 'pointer', flex: 1 }}
                  onClick={() => gameStore.drillToAgentDetail(member.agentId)}
                >
                  {name}
                </span>
                <span style={{
                  fontFamily: FONTS.body,
                  fontSize: 10,
                  color: colors.gold,
                  backgroundColor: colors.gold + '22',
                  padding: '1px 6px',
                  borderRadius: 3,
                  textTransform: 'capitalize',
                }}>
                  {member.role}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Group Chat */}
      <div style={{ height: 1, backgroundColor: colors.border, opacity: 0.3, margin: '16px 0' }} />
      <GroupChat institutionId={institutionId} memberIds={memberIds} />
    </div>
  );
};
