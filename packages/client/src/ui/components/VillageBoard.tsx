import React from 'react';
import { useBoard } from '../../core/hooks';
import { FONTS } from '../styles';
import { useTheme } from '../ThemeContext';

const TYPE_STYLES: Record<string, { icon: string; color: string }> = {
  decree: { icon: '\u{1F451}', color: '#ff6b6b' },
  rule: { icon: '\u{2696}', color: '#fbbf24' },
  announcement: { icon: '\u{1F4E2}', color: '#60a5fa' },
  rumor: { icon: '\u{1F444}', color: '#a78bfa' },
  threat: { icon: '\u{1F525}', color: '#ef4444' },
  alliance: { icon: '\u{1F91D}', color: '#4ade80' },
  bounty: { icon: '\u{1F3AF}', color: '#f97316' },
};

export const VillageBoard: React.FC = () => {
  const { colors } = useTheme();
  const board = useBoard();

  return (
    <div
      style={{
        padding: 12,
        fontFamily: FONTS.body,
        fontSize: '13px',
        color: colors.text,
      }}
    >
      {board.length === 0 ? (
        <div
          style={{
            textAlign: 'center',
            color: colors.textDim,
            padding: '24px 12px',
          }}
        >
          The village board is empty.
          <br />
          <span style={{ fontSize: '11px', marginTop: 8, display: 'block' }}>
            Agents will post decrees, rumors, and announcements here.
          </span>
        </div>
      ) : (
        [...board].reverse().map((post) => {
          const style = TYPE_STYLES[post.type] || TYPE_STYLES.announcement;
          return (
            <div
              key={post.id}
              style={{
                marginBottom: 8,
                padding: '8px 10px',
                background: colors.bgCard,
                borderRadius: 4,
                borderLeft: `3px solid ${style.color}`,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  marginBottom: 4,
                }}
              >
                <span style={{ fontSize: '10px' }}>{style.icon}</span>
                <span
                  style={{
                    color: style.color,
                    textTransform: 'uppercase',
                    fontSize: '9px',
                    fontFamily: FONTS.pixel,
                    letterSpacing: 1,
                  }}
                >
                  {post.type}
                </span>
                <span style={{ color: colors.textDim, fontSize: '11px' }}>
                  by {post.authorName}
                </span>
              </div>
              <div style={{ color: colors.text, lineHeight: '1.6' }}>
                {post.ruleAction || post.content}
              </div>
              {post.type === 'rule' && post.ruleAppliesTo && (
                <div style={{ marginTop: 4, fontSize: '11px', lineHeight: '1.4' }}>
                  <div><span style={{ color: '#fbbf24', fontWeight: 'bold' }}>Applies to:</span>{' '}
                    <span style={{ color: colors.textDim }}>{post.ruleAppliesTo}</span>
                  </div>
                  {post.ruleConsequence && (
                    <div><span style={{ color: '#ef4444', fontWeight: 'bold' }}>Consequence:</span>{' '}
                      <span style={{ color: colors.textDim }}>{post.ruleConsequence}</span>
                    </div>
                  )}
                </div>
              )}
              <div
                style={{
                  color: colors.textDim,
                  fontSize: '10px',
                  marginTop: 4,
                }}
              >
                Day {post.day}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
};
