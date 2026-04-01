import React, { useState } from 'react';
import { useAgents, useSelectedAgent, useBoard, useInstitutions } from '../../core/hooks';
import { gameStore } from '../../core/GameStore';
import { selectAgent } from '../../network/socket';
import { AgentCard } from './AgentCard';
import { COLORS, FONTS } from '../styles';

type Tab = 'agents' | 'info';

interface OverlayPanelProps {
  onAddAgent?: () => void;
}

export const OverlayPanel: React.FC<OverlayPanelProps> = ({ onAddAgent }) => {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('agents');

  const agents = useAgents();
  const selectedAgent = useSelectedAgent();
  const aliveAgents = agents.filter(a => a.alive !== false);

  const board = useBoard();
  const institutions = useInstitutions();
  const passedRules = board.filter(p => p.type === 'rule' && p.ruleStatus === 'passed' && !p.revoked);
  const activeInstitutions = institutions.filter(i => !i.dissolved);
  const infoCount = passedRules.length + activeInstitutions.length;

  return (
    <div style={{ position: 'absolute', top: 48, left: 8, zIndex: 20, pointerEvents: 'auto' }}>
      {/* Toggle pill */}
      <button
        onClick={() => setOpen(prev => !prev)}
        style={{
          padding: '5px 12px',
          fontFamily: FONTS.pixel,
          fontSize: '8px',
          color: open ? COLORS.accent : COLORS.textDim,
          background: COLORS.bg,
          border: `1px solid ${open ? COLORS.accent : COLORS.border}`,
          borderRadius: 4,
          cursor: 'pointer',
          letterSpacing: 0.5,
        }}
      >
        {open ? '✕' : `VILLAGE (${aliveAgents.length})`}
      </button>

      {/* Panel */}
      {open && (
        <div
          style={{
            marginTop: 4,
            width: 300,
            maxHeight: 450,
            display: 'flex',
            flexDirection: 'column',
            background: COLORS.bg,
            border: `1px solid ${COLORS.border}`,
            borderRadius: 6,
            boxShadow: '0 4px 24px rgba(0,0,0,0.5)',
            overflow: 'hidden',
          }}
        >
          {/* Tabs */}
          <div style={{ display: 'flex', borderBottom: `1px solid ${COLORS.border}`, flexShrink: 0 }}>
            <button
              onClick={() => setTab('agents')}
              style={{
                flex: 1,
                padding: '8px 0',
                fontFamily: FONTS.pixel,
                fontSize: '7px',
                color: tab === 'agents' ? COLORS.accent : COLORS.textDim,
                background: tab === 'agents' ? COLORS.bgHover : 'transparent',
                border: 'none',
                borderBottom: tab === 'agents' ? `2px solid ${COLORS.accent}` : '2px solid transparent',
                cursor: 'pointer',
                letterSpacing: 1,
              }}
            >
              AGENTS ({aliveAgents.length})
            </button>
            <button
              onClick={() => setTab('info')}
              style={{
                flex: 1,
                padding: '8px 0',
                fontFamily: FONTS.pixel,
                fontSize: '7px',
                color: tab === 'info' ? COLORS.accent : COLORS.textDim,
                background: tab === 'info' ? COLORS.bgHover : 'transparent',
                border: 'none',
                borderBottom: tab === 'info' ? `2px solid ${COLORS.accent}` : '2px solid transparent',
                cursor: 'pointer',
                letterSpacing: 1,
              }}
            >
              RULES & INFO {infoCount > 0 ? `(${infoCount})` : ''}
            </button>
          </div>

          {/* Content */}
          <div style={{ flex: 1, overflowY: 'auto', overscrollBehavior: 'contain', minHeight: 0 }}>
            {tab === 'agents' && (
              <>
                {onAddAgent && (
                  <button
                    onClick={() => { onAddAgent(); setOpen(false); }}
                    style={{
                      width: '100%',
                      padding: '12px 16px',
                      background: 'transparent',
                      border: 'none',
                      borderBottom: `1px solid ${COLORS.border}`,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      fontFamily: FONTS.pixel,
                      fontSize: '8px',
                      color: COLORS.accent,
                      letterSpacing: 1,
                      transition: 'background 0.15s',
                    }}
                    onMouseEnter={e => { e.currentTarget.style.background = COLORS.bgHover; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                  >
                    + ADD AGENT
                  </button>
                )}
                {aliveAgents.map(agent => (
                  <AgentCard
                    key={agent.id}
                    agent={agent}
                    selected={selectedAgent?.id === agent.id}
                    onClick={() => {
                      selectAgent(agent.id);
                      gameStore.inspectAgent(agent.id);
                      setOpen(false);
                    }}
                  />
                ))}
              </>
            )}

            {tab === 'info' && (
              <>
                {/* Active rules */}
                {passedRules.length > 0 && (
                  <>
                    <div style={{ padding: '8px 14px', fontFamily: FONTS.pixel, fontSize: '7px', color: '#fbbf24', letterSpacing: 1 }}>
                      ACTIVE RULES ({passedRules.length})
                    </div>
                    {passedRules.map(rule => (
                      <div
                        key={rule.id}
                        style={{
                          padding: '8px 14px',
                          borderBottom: `1px solid ${COLORS.border}`,
                          fontFamily: FONTS.body,
                          fontSize: '11px',
                          color: COLORS.textDim,
                          lineHeight: 1.4,
                        }}
                      >
                        <span style={{ color: COLORS.text }}>{rule.content}</span>
                        <div style={{ fontSize: '10px', color: COLORS.textDim, marginTop: 2 }}>
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
                      padding: '8px 14px',
                      fontFamily: FONTS.pixel,
                      fontSize: '7px',
                      color: '#8b5cf6',
                      letterSpacing: 1,
                      marginTop: passedRules.length > 0 ? 4 : 0,
                    }}>
                      INSTITUTIONS ({activeInstitutions.length})
                    </div>
                    {activeInstitutions.map(inst => (
                      <div
                        key={inst.id}
                        onClick={() => { gameStore.inspectInstitution(inst.id); setOpen(false); }}
                        style={{
                          padding: '8px 14px',
                          borderBottom: `1px solid ${COLORS.border}`,
                          fontFamily: FONTS.body,
                          fontSize: '11px',
                          color: COLORS.textDim,
                          cursor: 'pointer',
                          transition: 'background 0.15s',
                        }}
                        onMouseEnter={e => { e.currentTarget.style.background = COLORS.bgHover; }}
                        onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                      >
                        <span style={{ color: COLORS.text, fontWeight: 'bold' }}>{inst.name}</span>
                        <span style={{ marginLeft: 6, color: COLORS.textDim }}>({inst.type})</span>
                        <div style={{ fontSize: '10px', marginTop: 2 }}>
                          {inst.members.length} members — Treasury: {inst.treasury}
                        </div>
                      </div>
                    ))}
                  </>
                )}

                {passedRules.length === 0 && activeInstitutions.length === 0 && (
                  <div style={{ padding: '16px 14px', textAlign: 'center', fontFamily: FONTS.body, fontSize: '12px', color: COLORS.textDim }}>
                    No active rules or institutions yet.
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
