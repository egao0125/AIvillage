import React, { useState, useEffect } from 'react';
import { AgentForm } from './AgentForm';
import { nameToColor, hexToString } from '../../utils/color';
import { authHeaders } from '../../utils/auth';
import { COLORS, FONTS } from '../styles';

interface AgentCreatorProps {
  open: boolean;
  onClose: () => void;
}

interface AgentEntry {
  id: string;
  name: string;
  occupation?: string;
  soul: string;
  startingGold: number;
}

export const AgentCreator: React.FC<AgentCreatorProps> = ({ open, onClose }) => {
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('claude-sonnet-4-6');
  const [error, setError] = useState('');
  const [agents, setAgents] = useState<AgentEntry[]>([]);

  useEffect(() => {
    if (!open) return;
    setError('');
    const loadAgents = async () => {
      try {
        const res = await fetch('/api/config/status', { headers: authHeaders() });
        if (res.ok) {
          const data = await res.json() as { agents?: AgentEntry[] };
          if (Array.isArray(data.agents)) {
            setAgents(data.agents);
          }
        }
      } catch {
        // silently fail
      }
    };
    loadAgents();
  }, [open]);

  if (!open) return null;

  const handleCreated = (agent: AgentEntry) => {
    setAgents((prev) => [...prev, agent]);
    setError('');
  };

  const handleDelete = async (id: string, name: string) => {
    if (!window.confirm(`Delete agent "${name}"?`)) return;
    try {
      const res = await fetch(`/api/agents/${id}`, {
        method: 'DELETE',
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error('Failed to delete');
      setAgents((prev) => prev.filter((a) => a.id !== id));
    } catch {
      setError(`Failed to delete agent "${name}"`);
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 200,
        background: 'rgba(0,0,0,0.85)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 700,
          maxHeight: '90vh',
          overflowY: 'auto',
          background: COLORS.bg,
          border: `1px solid ${COLORS.border}`,
          borderRadius: 8,
          padding: 24,
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <span style={{ fontFamily: FONTS.pixel, fontSize: 10, color: COLORS.accent, letterSpacing: 2 }}>
            MANAGE AGENTS
          </span>
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              color: COLORS.textDim,
              cursor: 'pointer',
              fontFamily: FONTS.pixel,
              fontSize: 12,
              padding: '4px 8px',
            }}
          >
            X
          </button>
        </div>

        {/* Agent form */}
        <AgentForm
          apiKey={apiKey}
          model={model}
          onApiKeyChange={setApiKey}
          onModelChange={setModel}
          onCreated={handleCreated}
          onError={setError}
        />

        {/* Error display */}
        {error && (
          <div style={{
            marginTop: 12,
            padding: '8px 12px',
            background: 'rgba(255,107,107,0.15)',
            border: `1px solid ${COLORS.warning}`,
            borderRadius: 4,
            fontFamily: FONTS.pixel,
            fontSize: 7,
            color: COLORS.warning,
          }}>
            {error}
          </div>
        )}

        {/* Agent roster */}
        {agents.length > 0 && (
          <div style={{ marginTop: 24 }}>
            <div style={{ fontFamily: FONTS.pixel, fontSize: 8, color: COLORS.textDim, letterSpacing: 1, marginBottom: 12 }}>
              AGENTS ({agents.length})
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {agents.map((agent) => {
                const color = hexToString(nameToColor(agent.name));
                return (
                  <div
                    key={agent.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      padding: '10px 12px',
                      background: COLORS.bgLight,
                      border: `1px solid ${COLORS.border}`,
                      borderRadius: 4,
                    }}
                  >
                    {/* Avatar circle */}
                    <div
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: '50%',
                        background: color,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontFamily: FONTS.pixel,
                        fontSize: 10,
                        color: '#000',
                        flexShrink: 0,
                      }}
                    >
                      {agent.name.charAt(0).toUpperCase()}
                    </div>
                    {/* Name + soul preview */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontFamily: FONTS.pixel, fontSize: 8, color: COLORS.text }}>
                        {agent.name}
                      </div>
                      <div style={{
                        fontFamily: FONTS.body,
                        fontSize: 11,
                        color: COLORS.textDim,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}>
                        {agent.soul ? agent.soul.slice(0, 40) + (agent.soul.length > 40 ? '...' : '') : ''}
                      </div>
                    </div>
                    {/* Delete button */}
                    <button
                      onClick={() => handleDelete(agent.id, agent.name)}
                      style={{
                        background: 'none',
                        border: `1px solid ${COLORS.border}`,
                        borderRadius: 4,
                        color: COLORS.warning,
                        cursor: 'pointer',
                        fontFamily: FONTS.pixel,
                        fontSize: 7,
                        padding: '4px 8px',
                        flexShrink: 0,
                      }}
                    >
                      DEL
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
