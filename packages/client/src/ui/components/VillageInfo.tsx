import React, { useState } from 'react';
import { useBoard, useInstitutions } from '../../core/hooks';
import { gameStore } from '../../core/GameStore';
import { FONTS } from '../styles';
import { useTheme } from '../ThemeContext';

export const VillageInfo: React.FC = () => {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const board = useBoard();
  const institutions = useInstitutions();

  const passedRules = board.filter(p => p.type === 'rule' && p.ruleStatus === 'passed' && !p.revoked);
  const activeInstitutions = institutions.filter(i => !i.dissolved);
  const totalCount = passedRules.length + activeInstitutions.length;

  return (
    <div style={{ position: 'absolute', top: 48, left: 120, zIndex: 20, pointerEvents: 'auto', background: colors.bg, borderRadius: 6 }}>
      {/* Toggle pill */}
      <button
        onClick={() => setOpen(prev => !prev)}
        style={{
          padding: '5px 12px',
          fontFamily: FONTS.pixel,
          fontSize: '8px',
          color: open ? colors.accent : colors.textDim,
          background: colors.bg,
          border: `1px solid ${open ? colors.accent : colors.border}`,
          borderRadius: 4,
          cursor: 'pointer',
          letterSpacing: 0.5,
        }}
      >
        RULES & INFO {totalCount > 0 ? `(${totalCount})` : ''}
      </button>

      {/* Info panel */}
      {open && (
        <div
          style={{
            marginTop: 4,
            width: 320,
            maxHeight: 400,
            overflowY: 'auto',
            overscrollBehavior: 'contain',
            background: colors.bg,
            border: `1px solid ${colors.border}`,
            borderRadius: 6,
            boxShadow: '0 4px 24px rgba(0,0,0,0.5)',
            padding: '8px 0',
          }}
        >
          {/* Active rules */}
          {passedRules.length > 0 && (
            <>
              <div style={{
                padding: '6px 14px',
                fontFamily: FONTS.pixel,
                fontSize: '7px',
                color: '#fbbf24',
                letterSpacing: 1,
              }}>
                ACTIVE RULES ({passedRules.length})
              </div>
              {passedRules.map(rule => (
                <div
                  key={rule.id}
                  style={{
                    padding: '8px 14px',
                    borderBottom: `1px solid ${colors.border}`,
                    fontFamily: FONTS.body,
                    fontSize: '11px',
                    color: colors.textDim,
                    lineHeight: 1.4,
                  }}
                >
                  <span style={{ color: colors.text }}>{rule.content}</span>
                  <div style={{ fontSize: '10px', color: colors.textDim, marginTop: 2 }}>
                    by {rule.authorName} — Day {rule.day}
                  </div>
                </div>
              ))}
            </>
          )}

          {/* Active institutions */}
          {activeInstitutions.length > 0 && (
            <>
              <div style={{
                padding: '6px 14px',
                fontFamily: FONTS.pixel,
                fontSize: '7px',
                color: '#8b5cf6',
                letterSpacing: 1,
                marginTop: passedRules.length > 0 ? 8 : 0,
              }}>
                INSTITUTIONS ({activeInstitutions.length})
              </div>
              {activeInstitutions.map(inst => (
                <div
                  key={inst.id}
                  onClick={() => { gameStore.openDetail({ type: 'institution', id: inst.id }); setOpen(false); }}
                  style={{
                    padding: '8px 14px',
                    borderBottom: `1px solid ${colors.border}`,
                    fontFamily: FONTS.body,
                    fontSize: '11px',
                    color: colors.textDim,
                    cursor: 'pointer',
                    transition: 'background 0.15s',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.background = colors.bgHover; }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                >
                  <span style={{ color: colors.text, fontWeight: 'bold' }}>{inst.name}</span>
                  <span style={{ marginLeft: 6, color: colors.textDim }}>({inst.type})</span>
                  <div style={{ fontSize: '10px', marginTop: 2 }}>
                    {inst.members.length} members — Treasury: {inst.treasury}
                  </div>
                </div>
              ))}
            </>
          )}

          {totalCount === 0 && (
            <div style={{ padding: '16px 14px', textAlign: 'center', fontFamily: FONTS.body, fontSize: '12px', color: colors.textDim }}>
              No active rules or institutions yet.
            </div>
          )}
        </div>
      )}
    </div>
  );
};
