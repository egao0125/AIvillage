import React, { useState } from 'react';
import type { Agent, Item, Skill } from '@ai-village/shared';
import { nameToColor, hexToString } from '../../utils/color';
import { useReputation, useAgents, useBoard, useArtifacts } from '../../core/hooks';
import { COLORS, FONTS } from '../styles';
import { authHeaders, getUserId } from '../../utils/auth';

// --- Leave / Return Village Button ---

const LeaveReturnButton: React.FC<{ agent: Agent }> = ({ agent }) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const isAway = agent.state === 'away';

  const handleClick = async () => {
    setLoading(true);
    setError('');
    const endpoint = isAway
      ? `/api/agents/${agent.id}/resume`
      : `/api/agents/${agent.id}/suspend`;
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
      });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error || 'Failed');
      }
    } catch {
      setError('Cannot reach server');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ marginBottom: 14 }}>
      <button
        onClick={handleClick}
        disabled={loading}
        style={{
          width: '100%',
          padding: '8px 0',
          fontFamily: FONTS.pixel,
          fontSize: '9px',
          color: loading ? COLORS.textDim : isAway ? '#4ade80' : '#f59e0b',
          background: 'transparent',
          border: `1px solid ${loading ? COLORS.border : isAway ? '#4ade80' : '#f59e0b'}`,
          borderRadius: 4,
          cursor: loading ? 'wait' : 'pointer',
          letterSpacing: 1,
          transition: 'all 0.15s',
        }}
      >
        {loading ? '...' : isAway ? 'RETURN TO VILLAGE' : 'LEAVE VILLAGE'}
      </button>
      {error && (
        <div style={{ color: '#ef4444', fontSize: '10px', marginTop: 4, fontFamily: FONTS.pixel }}>
          {error}
        </div>
      )}
    </div>
  );
};

// --- Update API Key ---

const MODELS = [
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { value: 'claude-opus-4-6', label: 'Opus 4.6' },
];

const UpdateApiKeyButton: React.FC<{ agent: Agent }> = ({ agent }) => {
  const [expanded, setExpanded] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('claude-sonnet-4-6');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  const handleUpdate = async () => {
    if (!apiKey.trim() || apiKey.trim().length < 10) {
      setError('Enter a valid API key');
      return;
    }
    setLoading(true);
    setError('');
    setSuccess(false);
    try {
      const res = await fetch(`/api/agents/${agent.id}/api-key`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ apiKey: apiKey.trim(), model }),
      });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error || 'Failed');
      } else {
        setSuccess(true);
        setApiKey('');
        setTimeout(() => { setSuccess(false); setExpanded(false); }, 2000);
      }
    } catch {
      setError('Cannot reach server');
    } finally {
      setLoading(false);
    }
  };

  const isExhausted = agent.currentAction === 'API exhausted';

  return (
    <div style={{ marginBottom: 14 }}>
      <button
        onClick={() => { setExpanded(!expanded); setError(''); setSuccess(false); }}
        style={{
          width: '100%',
          padding: '8px 0',
          fontFamily: FONTS.pixel,
          fontSize: '9px',
          color: isExhausted ? '#ef4444' : COLORS.textDim,
          background: 'transparent',
          border: `1px solid ${isExhausted ? '#ef4444' : COLORS.border}`,
          borderRadius: 4,
          cursor: 'pointer',
          letterSpacing: 1,
          transition: 'all 0.15s',
        }}
      >
        {isExhausted ? 'API EXHAUSTED — UPDATE KEY' : 'UPDATE API KEY'}
      </button>
      {expanded && (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-ant-api03-..."
            style={{
              width: '100%',
              padding: '8px 10px',
              fontFamily: 'monospace',
              fontSize: '11px',
              color: COLORS.text,
              background: COLORS.bgCard,
              border: `1px solid ${COLORS.border}`,
              borderRadius: 4,
              boxSizing: 'border-box',
            }}
          />
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            style={{
              width: '100%',
              padding: '8px 10px',
              fontFamily: FONTS.pixel,
              fontSize: '8px',
              color: COLORS.text,
              background: COLORS.bgCard,
              border: `1px solid ${COLORS.border}`,
              borderRadius: 4,
              cursor: 'pointer',
            }}
          >
            {MODELS.map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
          <button
            onClick={handleUpdate}
            disabled={loading}
            style={{
              width: '100%',
              padding: '8px 0',
              fontFamily: FONTS.pixel,
              fontSize: '9px',
              color: loading ? COLORS.textDim : success ? '#4ade80' : '#64ffda',
              background: 'transparent',
              border: `1px solid ${loading ? COLORS.border : success ? '#4ade80' : '#64ffda'}`,
              borderRadius: 4,
              cursor: loading ? 'wait' : 'pointer',
              letterSpacing: 1,
              transition: 'all 0.15s',
            }}
          >
            {loading ? '...' : success ? 'UPDATED' : 'SAVE'}
          </button>
          {error && (
            <div style={{ color: '#ef4444', fontSize: '10px', fontFamily: FONTS.pixel }}>
              {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

const MOOD_DISPLAY: Record<string, { emoji: string; label: string; color: string }> = {
  neutral: { emoji: '\u{1F610}', label: 'Neutral', color: '#9ca3af' },
  happy: { emoji: '\u{1F60A}', label: 'Happy', color: '#4ade80' },
  angry: { emoji: '\u{1F620}', label: 'Angry', color: '#ef4444' },
  sad: { emoji: '\u{1F622}', label: 'Sad', color: '#60a5fa' },
  anxious: { emoji: '\u{1F630}', label: 'Anxious', color: '#fbbf24' },
  excited: { emoji: '\u{1F929}', label: 'Excited', color: '#f97316' },
  scheming: { emoji: '\u{1F914}', label: 'Scheming', color: '#a855f7' },
  afraid: { emoji: '\u{1F628}', label: 'Afraid', color: '#94a3b8' },
};

const ITEM_TYPE_COLORS: Record<string, string> = {
  tool: '#60a5fa',
  food: '#4ade80',
  material: '#a78bfa',
  art: '#f97316',
  medicine: '#ef4444',
  document: '#fbbf24',
  gift: '#ec4899',
  other: '#9ca3af',
};

const sectionLabel: React.CSSProperties = {
  color: COLORS.textAccent,
  marginBottom: 6,
  fontSize: '9px',
  fontFamily: FONTS.pixel,
  textTransform: 'uppercase' as const,
  letterSpacing: 1,
};

interface AgentProfileProps {
  agent: Agent;
  onClose: () => void;
}

export const AgentProfile: React.FC<AgentProfileProps> = ({
  agent,
  onClose,
}) => {
  const color = hexToString(nameToColor(agent.config.name));
  const reputation = useReputation();
  const allAgents = useAgents();
  const board = useBoard();
  const artifacts = useArtifacts();
  const agentReputation = reputation.filter((r) => r.fromAgentId === agent.id);

  // Helper to resolve agent ID to name
  const resolveName = (id: string): string => {
    const found = allAgents.find(a => a.id === id);
    return found?.config.name ?? id.slice(0, 8);
  };

  // Build notable relationships
  const notableRelationships: { emoji: string; text: string }[] = [];

  // Alliances from board posts
  const alliancePosts = board.filter(p => p.type === 'alliance' && !p.revoked && p.authorId === agent.id);
  for (const post of alliancePosts) {
    notableRelationships.push({ emoji: '\u{1F91D}', text: `Allied: ${post.content.slice(0, 60)}` });
  }

  // Strong trust/distrust from mental models
  if (agent.mentalModels) {
    for (const model of agent.mentalModels) {
      const name = resolveName(model.targetId);
      if (model.trust >= 50) {
        notableRelationships.push({ emoji: '\u{1F49A}', text: `Trusts ${name} (${model.trust})` });
      } else if (model.trust <= -30) {
        notableRelationships.push({ emoji: '\u{1F624}', text: `Distrusts ${name} (${model.trust})` });
      }
    }
  }

  // Letters written
  const letters = artifacts.filter(a => a.type === 'letter' && a.creatorId === agent.id);
  for (const letter of letters.slice(-2)) {
    notableRelationships.push({ emoji: '\u{1F48C}', text: `Wrote letter: "${letter.title}"` });
  }

  // Bidirectional: who thinks what about this agent
  const othersModels: { name: string; trust: number; stance: string }[] = [];
  for (const other of allAgents) {
    if (other.id === agent.id || !other.mentalModels) continue;
    const model = other.mentalModels.find(m => m.targetId === agent.id);
    if (model) {
      othersModels.push({ name: other.config.name, trust: model.trust, stance: model.emotionalStance });
    }
  }

  const moodInfo = MOOD_DISPLAY[agent.mood] || MOOD_DISPLAY.neutral;

  return (
    <div
      style={{
        padding: 16,
        fontFamily: FONTS.body,
        fontSize: '13px',
        color: COLORS.text,
        borderBottom: `1px solid ${COLORS.border}`,
      }}
    >
      {/* Dead state indicator */}
      {agent.alive === false && (
        <div style={{
          padding: '8px 12px',
          marginBottom: 10,
          background: '#1a0000',
          border: '1px solid #4a0000',
          borderRadius: 4,
          fontFamily: FONTS.pixel,
          fontSize: '9px',
          color: '#ff4444',
          textAlign: 'center',
          letterSpacing: 1,
        }}>
          DECEASED — {agent.causeOfDeath || 'unknown cause'}
        </div>
      )}

      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          marginBottom: 14,
        }}
      >
        <div
          style={{
            width: 48,
            height: 48,
            borderRadius: '50%',
            background: color,
            border: `2px solid ${COLORS.accent}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '18px',
            flexShrink: 0,
          }}
        >
          {agent.config.name[0]}
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: '11px', marginBottom: 4, fontFamily: FONTS.pixel }}>
            {agent.config.name}
          </div>
          <div style={{ color: COLORS.textDim, fontSize: '13px' }}>
            {agent.config.occupation}, {agent.config.age}
          </div>
        </div>
        <button
          onClick={onClose}
          style={{
            background: 'none',
            border: 'none',
            color: COLORS.textDim,
            cursor: 'pointer',
            fontSize: '14px',
            fontFamily: FONTS.body,
          }}
        >
          {'\u2715'}
        </button>
      </div>

      {/* Currency + Mood row */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 12px',
            background: COLORS.bgCard,
            borderRadius: 4,
            border: `1px solid ${COLORS.border}`,
          }}
        >
          <span style={{ fontSize: '16px' }}>{'\u{1FA99}'}</span>
          <div>
            <div style={{ color: COLORS.gold, fontSize: '13px', fontWeight: 'bold' }}>
              {agent.currency ?? 0} Gold
            </div>
          </div>
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '8px 12px',
            background: COLORS.bgCard,
            borderRadius: 4,
            border: `1px solid ${COLORS.border}`,
          }}
        >
          <span style={{ fontSize: '16px' }}>{moodInfo.emoji}</span>
          <span style={{ color: moodInfo.color, fontSize: '13px' }}>
            {moodInfo.label}
          </span>
        </div>
      </div>

      {/* Vitals */}
      {agent.vitals && agent.alive !== false && (
        <div style={{ marginBottom: 14 }}>
          <div style={sectionLabel}>VITALS</div>
          {(['health', 'hunger', 'energy'] as const).map(vital => {
            const value = agent.vitals![vital];
            const colors = {
              health: { bar: '#ef4444', bg: '#3b1111' },
              hunger: { bar: '#f59e0b', bg: '#3b2e11' },
              energy: { bar: '#3b82f6', bg: '#11213b' },
            };
            const labels = { health: 'HP', hunger: 'Hunger', energy: 'Energy' };
            const c = colors[vital];
            return (
              <div key={vital} style={{ marginBottom: 6 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                  <span style={{ color: COLORS.textDim, fontSize: '11px' }}>{labels[vital]}</span>
                  <span style={{ color: c.bar, fontSize: '11px', fontFamily: FONTS.pixel }}>{Math.round(value)}</span>
                </div>
                <div style={{ width: '100%', height: 6, background: c.bg, borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{
                    width: `${value}%`,
                    height: '100%',
                    background: vital === 'hunger' && value > 80 ? '#ef4444' : c.bar,
                    borderRadius: 3,
                    transition: 'width 0.3s',
                  }} />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Drives */}
      {agent.drives && agent.alive !== false && (
        <div style={{ marginBottom: 14 }}>
          <div style={sectionLabel}>DRIVES</div>
          {(['survival', 'safety', 'belonging', 'status', 'meaning'] as const).map(drive => {
            const value = agent.drives![drive];
            const driveColors: Record<string, string> = {
              survival: '#ef4444',
              safety: '#f59e0b',
              belonging: '#ec4899',
              status: '#a855f7',
              meaning: '#06b6d4',
            };
            const driveEmojis: Record<string, string> = {
              survival: '\u{2764}\u{FE0F}',
              safety: '\u{1F6E1}\u{FE0F}',
              belonging: '\u{1F91D}',
              status: '\u{1F451}',
              meaning: '\u{2B50}',
            };
            return (
              <div key={drive} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <span style={{ fontSize: '11px', width: 16 }}>{driveEmojis[drive]}</span>
                <span style={{ color: COLORS.textDim, fontSize: '10px', width: 62, textTransform: 'capitalize' }}>{drive}</span>
                <div style={{ flex: 1, height: 4, background: COLORS.border, borderRadius: 2, overflow: 'hidden' }}>
                  <div style={{
                    width: `${value}%`,
                    height: '100%',
                    background: driveColors[drive],
                    borderRadius: 2,
                    transition: 'width 0.3s',
                  }} />
                </div>
                <span style={{ color: COLORS.textDim, fontSize: '10px', width: 24, textAlign: 'right', fontFamily: FONTS.pixel }}>{Math.round(value)}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* Soul */}
      {agent.config.soul && (
        <div style={{ marginBottom: 14 }}>
          <div style={sectionLabel}>SOUL</div>
          <div style={{ color: COLORS.textDim, lineHeight: '1.6', fontSize: '12px' }}>
            {agent.config.soul}
          </div>
        </div>
      )}

      {/* Current state */}
      <div style={{ marginBottom: 14 }}>
        <div style={sectionLabel}>STATUS</div>
        <div style={{ color: COLORS.textDim, fontSize: '13px' }}>
          {agent.currentAction || agent.state}
        </div>
      </div>

      {/* Owner controls: Leave/Return + Update API Key */}
      {agent.ownerId === getUserId() && agent.alive !== false && (
        <>
          <UpdateApiKeyButton agent={agent} />
          <LeaveReturnButton agent={agent} />
        </>
      )}

      {/* Notable Relationships */}
      {notableRelationships.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div style={sectionLabel}>RELATIONSHIPS</div>
          {notableRelationships.map((rel, i) => (
            <div key={i} style={{
              padding: '4px 10px',
              marginBottom: 2,
              fontSize: '11px',
              color: COLORS.text,
            }}>
              {rel.emoji} {rel.text}
            </div>
          ))}
        </div>
      )}

      {/* Mental Models — what this agent thinks of others */}
      {agent.mentalModels && agent.mentalModels.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div style={sectionLabel}>MIND ({agent.mentalModels.length})</div>
          {agent.mentalModels.map(model => (
            <div key={model.targetId} style={{
              padding: '6px 10px',
              marginBottom: 3,
              background: COLORS.bgCard,
              borderRadius: 4,
              border: `1px solid ${COLORS.border}`,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                <span style={{ color: COLORS.text, fontSize: '11px' }}>{resolveName(model.targetId)}</span>
                <span style={{
                  color: model.trust > 20 ? '#4ade80' : model.trust < -20 ? '#ef4444' : COLORS.textDim,
                  fontSize: '11px',
                  fontFamily: FONTS.pixel,
                }}>
                  {model.trust > 0 ? '+' : ''}{model.trust} trust
                </span>
              </div>
              <div style={{ color: COLORS.textDim, fontSize: '11px' }}>
                {model.emotionalStance} — thinks: "{model.predictedGoal}"
              </div>
            </div>
          ))}
        </div>
      )}

      {/* What others think of this agent */}
      {othersModels.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div style={sectionLabel}>OTHERS' VIEW</div>
          {othersModels.map((om, i) => (
            <div key={i} style={{
              padding: '6px 10px',
              marginBottom: 3,
              background: COLORS.bgCard,
              borderRadius: 4,
              border: `1px solid ${COLORS.border}`,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: COLORS.text, fontSize: '11px' }}>{om.name}</span>
                <span style={{
                  color: om.trust > 20 ? '#4ade80' : om.trust < -20 ? '#ef4444' : COLORS.textDim,
                  fontSize: '11px',
                  fontFamily: FONTS.pixel,
                }}>
                  {om.trust > 0 ? '+' : ''}{om.trust} trust
                </span>
              </div>
              <div style={{ color: COLORS.textDim, fontSize: '11px' }}>
                feels {om.stance}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Inventory */}
      {agent.inventory && agent.inventory.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div style={sectionLabel}>INVENTORY ({agent.inventory.length})</div>
          {agent.inventory.map((item: Item) => (
            <div
              key={item.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '6px 10px',
                marginBottom: 3,
                background: COLORS.bgCard,
                borderRadius: 4,
                border: `1px solid ${COLORS.border}`,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ color: COLORS.text, fontSize: '12px' }}>{item.name}</span>
                <span
                  style={{
                    fontSize: '9px',
                    padding: '2px 6px',
                    borderRadius: 3,
                    background: ITEM_TYPE_COLORS[item.type] || ITEM_TYPE_COLORS.other,
                    color: '#000',
                    fontWeight: 'bold',
                  }}
                >
                  {item.type.toUpperCase()}
                </span>
              </div>
              <span style={{ color: COLORS.gold, fontSize: '12px' }}>
                {item.value}g
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Skills */}
      {agent.skills && agent.skills.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div style={sectionLabel}>SKILLS</div>
          {agent.skills.map((skill: Skill) => (
            <div
              key={skill.name}
              style={{
                padding: '6px 10px',
                marginBottom: 3,
                background: COLORS.bgCard,
                borderRadius: 4,
                border: `1px solid ${COLORS.border}`,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  marginBottom: 4,
                }}
              >
                <span style={{ color: COLORS.text, fontSize: '12px' }}>{skill.name}</span>
                <span style={{ color: COLORS.textDim, fontSize: '12px' }}>
                  Lv.{skill.level}
                </span>
              </div>
              <div
                style={{
                  width: '100%',
                  height: 6,
                  background: COLORS.border,
                  borderRadius: 3,
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    width: `${Math.min(skill.level * 10, 100)}%`,
                    height: '100%',
                    background: COLORS.accent,
                    borderRadius: 3,
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Reputation */}
      {agentReputation.length > 0 && (
        <div>
          <div style={sectionLabel}>REPUTATION</div>
          {agentReputation.map((rep) => (
            <div
              key={`${rep.fromAgentId}-${rep.toAgentId}`}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                padding: '6px 10px',
                marginBottom: 3,
                background: COLORS.bgCard,
                borderRadius: 4,
                border: `1px solid ${COLORS.border}`,
              }}
            >
              <span style={{ color: COLORS.text, fontSize: '12px' }}>{resolveName(rep.toAgentId)}</span>
              <span
                style={{
                  color:
                    rep.score > 0
                      ? COLORS.active
                      : rep.score < 0
                      ? COLORS.warning
                      : COLORS.textDim,
                  fontSize: '12px',
                  fontWeight: 'bold',
                }}
              >
                {rep.score > 0 ? '+' : ''}
                {rep.score}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
