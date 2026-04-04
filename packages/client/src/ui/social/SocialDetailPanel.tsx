import React from 'react';
import { FONTS } from '../styles';
import { useTheme } from '../ThemeContext';
import type { ThemeColors } from '../styles';
import type { SocialNode, SocialEdge } from './types';
import type { MentalModel } from '@ai-village/shared';

interface NodeDetailProps {
  node: SocialNode;
  edges: SocialEdge[];
  allNodes: SocialNode[];
  onClose: () => void;
}

interface EdgeDetailProps {
  edge: SocialEdge;
  allNodes: SocialNode[];
  onClose: () => void;
}

type DetailProps = { type: 'node'; props: NodeDetailProps } | { type: 'edge'; props: EdgeDetailProps };

export const SocialDetailPanel: React.FC<DetailProps & { onClose: () => void }> = (detail) => {
  const { colors } = useTheme();
  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        width: 350,
        background: 'rgba(245, 245, 240, 0.96)',
        borderLeft: `1px solid ${colors.border}`,
        overflowY: 'auto',
        overscrollBehavior: 'contain',
        animation: 'socialPanelSlide 0.3s ease',
        zIndex: 10,
      }}
    >
      <div style={{ padding: 16 }}>
        {/* Close button */}
        <button
          onClick={detail.onClose}
          style={{
            position: 'absolute',
            top: 12,
            right: 12,
            background: 'none',
            border: 'none',
            color: colors.textDim,
            cursor: 'pointer',
            fontFamily: FONTS.body,
            fontSize: 18,
          }}
        >
          ✕
        </button>

        {detail.type === 'node' ? (
          <NodeDetail {...detail.props} />
        ) : (
          <EdgeDetail {...detail.props} />
        )}
      </div>
    </div>
  );
};

const NodeDetail: React.FC<NodeDetailProps> = ({ node, edges, allNodes }) => {
  const { colors } = useTheme();
  const nodeEdges = edges.filter(e => e.source === node.id || e.target === node.id);

  return (
    <>
      {/* Header */}
      <div style={{ marginBottom: 16 }}>
        <h2 style={{
          fontFamily: FONTS.pixel,
          fontSize: 14,
          color: colors.textAccent,
          margin: 0,
          letterSpacing: 1,
        }}>
          {node.name}
        </h2>
        <div style={{ color: colors.textDim, fontFamily: FONTS.body, fontSize: 12, marginTop: 4 }}>
          {node.mood} · {node.state}
        </div>
      </div>

      {/* Mental Models */}
      {node.mentalModels.length > 0 && (
        <Section title="Mental Models">
          {node.mentalModels.map((model: MentalModel) => {
            const targetNode = allNodes.find(n => n.id === model.targetId);
            return (
              <div key={model.targetId} style={{ marginBottom: 10, padding: '8px 10px', background: colors.bgCard, borderRadius: 4 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ color: colors.text, fontFamily: FONTS.body, fontSize: 12 }}>
                    {targetNode?.name || model.targetId}
                  </span>
                  <TrustBar trust={model.trust} />
                </div>
                <div style={{ color: colors.textDim, fontSize: 11, fontFamily: FONTS.body, marginTop: 4 }}>
                  {model.emotionalStance} — "{model.predictedGoal}"
                </div>
                {model.notes.length > 0 && (
                  <div style={{ marginTop: 4, fontSize: 10, color: colors.textDim, fontFamily: FONTS.body }}>
                    {model.notes.slice(-3).map((note, i) => (
                      <div key={i} style={{ marginTop: 2 }}>• {note}</div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </Section>
      )}

      {/* Ledger Entries — active first, expired hidden by default */}
      {node.ledgerEntries.length > 0 && (() => {
        const active = node.ledgerEntries.filter(e => e.status !== 'expired');
        const entries = active.length > 0 ? active : node.ledgerEntries;
        return (
        <Section title={`Agreements (${active.length} active)`}>
          {entries.slice(-10).reverse().map(entry => (
            <div key={entry.id} style={{ marginBottom: 6, padding: '6px 10px', background: colors.bgCard, borderRadius: 4 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{
                  color: colors.textAccent,
                  fontFamily: FONTS.pixel,
                  fontSize: 8,
                  textTransform: 'uppercase',
                }}>
                  {entry.type}
                </span>
                <StatusBadge status={entry.status} />
              </div>
              <div style={{ color: colors.text, fontSize: 11, fontFamily: FONTS.body, marginTop: 4 }}>
                {entry.description}
              </div>
            </div>
          ))}
        </Section>
        );
      })()}

      {/* Connections */}
      {nodeEdges.length > 0 && (
        <Section title={`Connections (${nodeEdges.length})`}>
          {nodeEdges.map(edge => {
            const otherId = edge.source === node.id ? edge.target : edge.source;
            const other = allNodes.find(n => n.id === otherId);
            return (
              <div key={edge.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: `1px solid ${colors.border}` }}>
                <span style={{ color: colors.text, fontSize: 12, fontFamily: FONTS.body }}>
                  {other?.name || otherId}
                </span>
                <span style={{ color: colors.textDim, fontSize: 11, fontFamily: FONTS.body }}>
                  {edge.interactionCount} interactions
                  {edge.hasDisagreement && <span style={{ color: colors.warning, marginLeft: 4 }}>⚠</span>}
                </span>
              </div>
            );
          })}
        </Section>
      )}

      {/* Institutions */}
      {node.institutionIds.length > 0 && (
        <Section title="Institutions">
          <div style={{ color: colors.textDim, fontSize: 11, fontFamily: FONTS.body }}>
            Member of {node.institutionIds.length} institution(s)
          </div>
        </Section>
      )}
    </>
  );
};

const EdgeDetail: React.FC<EdgeDetailProps> = ({ edge, allNodes }) => {
  const { colors } = useTheme();
  const sourceNode = allNodes.find(n => n.id === edge.source);
  const targetNode = allNodes.find(n => n.id === edge.target);

  // Find mental models of each other
  const sourceModelOfTarget = sourceNode?.mentalModels.find(m => m.targetId === edge.target);
  const targetModelOfSource = targetNode?.mentalModels.find(m => m.targetId === edge.source);

  return (
    <>
      {/* Header */}
      <div style={{ marginBottom: 16 }}>
        <h2 style={{
          fontFamily: FONTS.pixel,
          fontSize: 12,
          color: colors.textAccent,
          margin: 0,
          letterSpacing: 1,
        }}>
          {sourceNode?.name} ↔ {targetNode?.name}
        </h2>
        <div style={{ color: colors.textDim, fontFamily: FONTS.body, fontSize: 12, marginTop: 4 }}>
          {edge.interactionCount} interactions · mutual trust: {edge.avgReputation.toFixed(0)}
        </div>
      </div>

      {/* Mental Models Side-by-Side */}
      {(sourceModelOfTarget || targetModelOfSource) && (
        <Section title="How They See Each Other">
          <div style={{ display: 'flex', gap: 8 }}>
            <ModelCard
              label={`${sourceNode?.name}'s view`}
              model={sourceModelOfTarget}
            />
            <ModelCard
              label={`${targetNode?.name}'s view`}
              model={targetModelOfSource}
            />
          </div>
        </Section>
      )}

      {/* Shared Ledger History */}
      {edge.sharedEntries.length > 0 && (
        <Section title="Shared History">
          {edge.sharedEntries.slice(-10).reverse().map((match, i) => (
            <div
              key={i}
              style={{
                marginBottom: 8,
                padding: '8px 10px',
                background: match.disagreement ? 'rgba(255, 107, 107, 0.1)' : colors.bgCard,
                borderRadius: 4,
                borderLeft: match.disagreement ? `3px solid ${colors.warning}` : '3px solid transparent',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: colors.textAccent, fontFamily: FONTS.pixel, fontSize: 8, textTransform: 'uppercase' }}>
                  {match.sourceEntry.type}
                </span>
                {match.disagreement && (
                  <span style={{ color: colors.warning, fontSize: 10, fontFamily: FONTS.body }}>
                    DISAGREEMENT
                  </span>
                )}
              </div>
              <div style={{ color: colors.text, fontSize: 11, fontFamily: FONTS.body, marginTop: 4 }}>
                {match.sourceEntry.description}
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                <StatusBadge status={match.sourceEntry.status} label={sourceNode?.name} />
                {match.targetEntry && (
                  <StatusBadge status={match.targetEntry.status} label={targetNode?.name} />
                )}
              </div>
            </div>
          ))}
        </Section>
      )}
    </>
  );
};

// --- Shared components ---

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => {
  const { colors } = useTheme();
  return (
    <div style={{ marginBottom: 16 }}>
      <h3 style={{
        fontFamily: FONTS.pixel,
        fontSize: 9,
        color: colors.textDim,
        textTransform: 'uppercase',
        letterSpacing: 1,
        marginBottom: 8,
        borderBottom: `1px solid ${colors.border}`,
        paddingBottom: 4,
      }}>
        {title}
      </h3>
      {children}
    </div>
  );
};

/** Diverging trust bar: center = 0, left = -100, right = +100 */
const TrustBar: React.FC<{ trust: number }> = ({ trust }) => {
  const { colors } = useTheme();
  const barWidth = 80;
  const center = barWidth / 2;
  const magnitude = Math.abs(trust) / 100; // 0..1
  const fillWidth = magnitude * center;
  const isPositive = trust >= 0;
  const color = trust > 30 ? '#4ade80' : trust > 0 ? '#fbbf24' : trust > -30 ? '#fbbf24' : '#f87171';

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <div style={{ width: barWidth, height: 6, background: colors.border, borderRadius: 3, position: 'relative', overflow: 'hidden' }}>
        {/* Center line */}
        <div style={{ position: 'absolute', left: center - 0.5, top: 0, width: 1, height: '100%', background: 'rgba(255,255,255,0.2)' }} />
        {/* Fill bar — extends left for negative, right for positive */}
        <div style={{
          position: 'absolute',
          top: 0,
          height: '100%',
          background: color,
          borderRadius: 3,
          left: isPositive ? center : center - fillWidth,
          width: fillWidth,
        }} />
      </div>
      <span style={{ color, fontSize: 10, fontFamily: FONTS.body, minWidth: 28, textAlign: 'right', fontWeight: 600 }}>
        {trust > 0 ? '+' : ''}{trust}
      </span>
    </div>
  );
};

const StatusBadge: React.FC<{ status: string; label?: string }> = ({ status, label }) => {
  const { colors } = useTheme();
  const statusColors: Record<string, string> = {
    proposed: '#fbbf24',
    accepted: '#4ade80',
    rejected: '#f87171',
    expired: '#6b7280',
    fulfilled: '#64ffda',
    broken: '#ff6b6b',
  };
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      padding: '2px 6px',
      borderRadius: 3,
      background: `${statusColors[status] || colors.textDim}20`,
      color: statusColors[status] || colors.textDim,
      fontFamily: FONTS.pixel,
      fontSize: 7,
      textTransform: 'uppercase',
    }}>
      {label && <span style={{ color: colors.textDim }}>{label}:</span>}
      {status}
    </span>
  );
};

const ModelCard: React.FC<{ label: string; model?: MentalModel }> = ({ label, model }) => {
  const { colors } = useTheme();
  return (
    <div style={{ flex: 1, padding: 8, background: colors.bgCard, borderRadius: 4 }}>
      <div style={{ fontFamily: FONTS.pixel, fontSize: 7, color: colors.textDim, textTransform: 'uppercase', marginBottom: 4 }}>
        {label}
      </div>
      {model ? (
        <>
          <TrustBar trust={model.trust} />
          <div style={{ color: colors.text, fontSize: 10, fontFamily: FONTS.body, marginTop: 4 }}>
            {model.emotionalStance}
          </div>
          <div style={{ color: colors.textDim, fontSize: 10, fontFamily: FONTS.body, marginTop: 2 }}>
            "{model.predictedGoal}"
          </div>
        </>
      ) : (
        <div style={{ color: colors.textDim, fontSize: 10, fontFamily: FONTS.body }}>
          No model formed
        </div>
      )}
    </div>
  );
};
