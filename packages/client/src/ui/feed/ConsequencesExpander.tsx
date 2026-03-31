import React from 'react';
import type { VillageEvent } from './types';
import { COLORS, FONTS } from '../styles';

interface ConsequencesExpanderProps {
  event: VillageEvent;
}

const Row: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div style={{ display: 'flex', gap: 8, padding: '2px 0' }}>
    <span style={{ color: COLORS.textDim, minWidth: 80 }}>{label}:</span>
    <span style={{ color: COLORS.text }}>{value}</span>
  </div>
);

export const ConsequencesExpander: React.FC<ConsequencesExpanderProps> = ({ event }) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = event.sourceData as any;
  if (!data) return null;

  const content: React.ReactNode[] = [];

  if (event.type === 'rule') {
    if (data.ruleStatus) content.push(<Row key="status" label="Status" value={data.ruleStatus} />);
    if (data.ruleAction) content.push(<Row key="action" label="Action" value={data.ruleAction} />);
    if (data.ruleAppliesTo) content.push(<Row key="applies" label="Applies to" value={data.ruleAppliesTo} />);
    if (data.ruleConsequence) content.push(<Row key="consequence" label="Consequence" value={data.ruleConsequence} />);
    if (data.votes && data.votes.length > 0) {
      const likes = data.votes.filter((v: any) => v.vote === 'like').length;
      const dislikes = data.votes.filter((v: any) => v.vote === 'dislike').length;
      content.push(<Row key="votes" label="Votes" value={`${likes} for / ${dislikes} against`} />);
    }
  } else if (event.type === 'election') {
    if (data.winner) content.push(<Row key="winner" label="Winner" value={data.winner} />);
    const totalVotes = Object.keys(data.votes ?? {}).length;
    content.push(<Row key="totalVotes" label="Total votes" value={String(totalVotes)} />);
  } else if (event.type === 'institution') {
    content.push(<Row key="type" label="Type" value={data.type} />);
    content.push(<Row key="members" label="Members" value={String(data.members?.length ?? 0)} />);
    if (data.treasury > 0) content.push(<Row key="treasury" label="Treasury" value={String(data.treasury)} />);
  }

  if (content.length === 0) return null;

  return (
    <div
      style={{
        marginTop: 8,
        background: COLORS.bgLight,
        borderRadius: 4,
        padding: 8,
        fontFamily: FONTS.body,
        fontSize: '11px',
      }}
    >
      {content}
    </div>
  );
};
