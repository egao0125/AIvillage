import React from 'react';
import { useArtifacts } from '../../core/hooks';
import { COLORS, FONTS } from '../styles';

const TYPE_COLORS: Record<string, string> = {
  poem: '#a78bfa',
  newspaper: '#60a5fa',
  letter: '#ec4899',
  propaganda: '#ef4444',
  diary: '#9ca3af',
  painting: '#f97316',
  law: '#fbbf24',
  manifesto: '#4ade80',
  map: '#06b6d4',
  recipe: '#84cc16',
};

const TYPE_EMOJIS: Record<string, string> = {
  poem: '\u{1F4DD}',
  newspaper: '\u{1F4F0}',
  letter: '\u{2709}\u{FE0F}',
  propaganda: '\u{1F4E2}',
  diary: '\u{1F4D4}',
  painting: '\u{1F3A8}',
  law: '\u{2696}\u{FE0F}',
  manifesto: '\u{270A}',
  map: '\u{1F5FA}\u{FE0F}',
  recipe: '\u{1F373}',
};

export const ArtifactGallery: React.FC = () => {
  const artifacts = useArtifacts();
  const publicArtifacts = artifacts.filter(a => a.visibility === 'public');

  if (publicArtifacts.length === 0) {
    return (
      <div style={{ padding: 20, textAlign: 'center', color: COLORS.textDim, fontFamily: FONTS.body, fontSize: '13px' }}>
        No artifacts yet. Agents can write poems, newspapers, laws...
      </div>
    );
  }

  return (
    <div style={{ padding: '8px 0' }}>
      {[...publicArtifacts].reverse().map(artifact => (
        <div key={artifact.id} style={{
          padding: '12px 16px',
          borderBottom: `1px solid ${COLORS.border}`,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
            <span style={{ fontSize: '14px' }}>{TYPE_EMOJIS[artifact.type] || '\u{1F4C4}'}</span>
            <span style={{
              fontFamily: FONTS.pixel,
              fontSize: '9px',
              padding: '2px 6px',
              borderRadius: 3,
              background: TYPE_COLORS[artifact.type] || '#9ca3af',
              color: '#000',
              fontWeight: 'bold',
              textTransform: 'uppercase',
            }}>
              {artifact.type}
            </span>
            <span style={{ fontFamily: FONTS.body, fontSize: '11px', color: COLORS.textDim, marginLeft: 'auto' }}>
              by {artifact.creatorName} — Day {artifact.day}
            </span>
          </div>
          <div style={{
            fontFamily: FONTS.pixel,
            fontSize: '10px',
            color: COLORS.text,
            marginBottom: 4,
          }}>
            {artifact.title}
          </div>
          <div style={{
            fontFamily: FONTS.body,
            fontSize: '12px',
            color: COLORS.textDim,
            lineHeight: '1.6',
            whiteSpace: 'pre-wrap',
          }}>
            {artifact.content}
          </div>
          {artifact.reactions.length > 0 && (
            <div style={{ marginTop: 6, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {artifact.reactions.map((r, i) => (
                <span key={i} style={{
                  fontSize: '10px',
                  padding: '2px 6px',
                  borderRadius: 3,
                  background: COLORS.bgCard,
                  border: `1px solid ${COLORS.border}`,
                  color: COLORS.textDim,
                }}>
                  {r.agentName}: {r.reaction}
                </span>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
};
