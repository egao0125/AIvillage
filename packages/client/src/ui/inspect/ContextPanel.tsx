import React, { useState, useEffect, useRef } from 'react';
import { COLORS, FONTS } from '../styles';
import { gameStore, type InspectTarget } from '../../core/GameStore';
import { useInspectTarget, useAgentsMap } from '../../core/hooks';
import { AgentDetail } from './AgentDetail';
import { RelationshipDetail } from './RelationshipDetail';
import { EventDetail } from './EventDetail';
import { LocationDetail } from './LocationDetail';
import { InstitutionDetail } from './InstitutionDetail';

function targetLabel(target: InspectTarget, agentsMap: Map<string, { config: { name: string } }>): string {
  const getName = (id: string) => agentsMap.get(id)?.config.name ?? id.slice(0, 8);

  switch (target.type) {
    case 'agent':
      return `Agent: ${getName(target.id)}`;
    case 'relationship':
      return `${getName(target.id)} \u2194 ${getName(target.secondaryId!)}`;
    case 'event':
      return `Event`;
    case 'location':
      return `Location`;
    case 'institution':
      return `Institution`;
    default:
      return 'Unknown';
  }
}

export const ContextPanel: React.FC = () => {
  const inspectTarget = useInspectTarget();
  const agentsMap = useAgentsMap();
  const [breadcrumbs, setBreadcrumbs] = useState<InspectTarget[]>([]);
  const prevTargetRef = useRef<InspectTarget | null>(null);

  // Track breadcrumb navigation
  useEffect(() => {
    if (!inspectTarget) {
      setBreadcrumbs([]);
      prevTargetRef.current = null;
      return;
    }

    const prev = prevTargetRef.current;
    if (inspectTarget.drillDown && prev) {
      // Drill-down from within the panel — push to breadcrumbs
      setBreadcrumbs((bc) => [...bc, prev]);
    } else if (!inspectTarget.drillDown) {
      // Fresh selection from canvas/roster — reset breadcrumbs
      setBreadcrumbs([]);
    }
    prevTargetRef.current = inspectTarget;
  }, [inspectTarget]);

  const handleBack = () => {
    if (breadcrumbs.length > 0) {
      const newBreadcrumbs = [...breadcrumbs];
      const previous = newBreadcrumbs.pop()!;
      setBreadcrumbs(newBreadcrumbs);
      prevTargetRef.current = previous;
      gameStore.inspect(previous);
    } else {
      prevTargetRef.current = null;
      gameStore.backToWatch();
    }
  };

  const renderContent = () => {
    if (!inspectTarget) {
      return (
        <div style={{ fontFamily: FONTS.body, fontSize: 13, color: COLORS.textDim, textAlign: 'center', paddingTop: 40 }}>
          Select an entity to inspect
        </div>
      );
    }

    switch (inspectTarget.type) {
      case 'agent':
        return <AgentDetail agentId={inspectTarget.id} />;
      case 'relationship':
        return <RelationshipDetail agentId={inspectTarget.id} secondaryId={inspectTarget.secondaryId!} />;
      case 'event':
        return <EventDetail eventId={inspectTarget.id} />;
      case 'location':
        return <LocationDetail locationId={inspectTarget.id} />;
      case 'institution':
        return <InstitutionDetail institutionId={inspectTarget.id} />;
      default:
        return (
          <div style={{ fontFamily: FONTS.body, fontSize: 13, color: COLORS.textDim, padding: 16 }}>
            Unknown target type
          </div>
        );
    }
  };

  return (
    <div style={{
      width: 420,
      height: '100%',
      backgroundColor: COLORS.bg,
      borderLeft: `1px solid ${COLORS.border}`,
      padding: 16,
      overflowY: 'auto',
      boxSizing: 'border-box',
      display: 'flex',
      flexDirection: 'column',
    }}>
      {/* Header */}
      <div style={{ marginBottom: 12, flexShrink: 0 }}>
        {/* Back button */}
        <div
          style={{
            fontFamily: FONTS.body,
            fontSize: 12,
            color: COLORS.accent,
            cursor: 'pointer',
            marginBottom: 6,
          }}
          onClick={handleBack}
        >
          {'\u2190'} Watch
        </div>

        {/* Breadcrumbs */}
        {inspectTarget && breadcrumbs.length > 0 && (
          <div style={{ fontFamily: FONTS.body, fontSize: 10, color: COLORS.textDim, display: 'flex', flexWrap: 'wrap', gap: 2, alignItems: 'center' }}>
            <span>Watch</span>
            {breadcrumbs.map((bc, i) => (
              <React.Fragment key={i}>
                <span style={{ margin: '0 2px' }}>&gt;</span>
                <span>{targetLabel(bc, agentsMap as Map<string, { config: { name: string } }>)}</span>
              </React.Fragment>
            ))}
            <span style={{ margin: '0 2px' }}>&gt;</span>
            <span style={{ color: COLORS.text }}>
              {targetLabel(inspectTarget, agentsMap as Map<string, { config: { name: string } }>)}
            </span>
          </div>
        )}
      </div>

      {/* Content */}
      <div style={{ flex: 1, minHeight: 0 }}>
        {renderContent()}
      </div>
    </div>
  );
};
