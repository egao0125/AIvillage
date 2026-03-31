import React from 'react';
import type { VillageEvent } from './types';
import { nameToColor, hexToString } from '../../utils/color';
import { COLORS, FONTS } from '../styles';

interface ReactionsExpanderProps {
  event: VillageEvent;
}

interface Comment {
  name: string;
  text: string;
}

function extractReactions(event: VillageEvent): Comment[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = event.sourceData as any;
  if (!data) return [];

  const comments: Comment[] = [];

  // Board post comments
  if (data.comments && Array.isArray(data.comments)) {
    for (const c of data.comments) {
      if (c.agentName && c.content) {
        comments.push({ name: c.agentName, text: c.content });
      }
    }
  }

  // Artifact reactions
  if (data.reactions && Array.isArray(data.reactions)) {
    for (const r of data.reactions) {
      if (r.agentName && r.reaction) {
        const text = r.comment
          ? `${r.reaction} — "${r.comment}"`
          : r.reaction;
        comments.push({ name: r.agentName, text });
      }
    }
  }

  return comments;
}

export function getReactionCount(event: VillageEvent): number {
  return extractReactions(event).length;
}

export const ReactionsExpander: React.FC<ReactionsExpanderProps> = ({ event }) => {
  const reactions = extractReactions(event);
  if (reactions.length === 0) return null;

  return (
    <div
      style={{
        marginTop: 8,
        background: COLORS.bgLight,
        borderRadius: 4,
        padding: 8,
        fontFamily: FONTS.body,
        fontSize: '12px',
      }}
    >
      {reactions.map((r, i) => {
        const color = hexToString(nameToColor(r.name));
        return (
          <div key={i} style={{ padding: '3px 0', borderBottom: i < reactions.length - 1 ? `1px solid ${COLORS.border}22` : undefined }}>
            <span style={{ color, fontWeight: 'bold', marginRight: 6 }}>{r.name}:</span>
            <span style={{ color: COLORS.textDim }}>{r.text}</span>
          </div>
        );
      })}
    </div>
  );
};
