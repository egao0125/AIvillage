import React, { useState, useEffect } from 'react';
import { useThoughts, useAgents } from '../../core/hooks';
import { nameToColor, hexToString } from '../../utils/color';
import { COLORS, FONTS } from '../styles';

export const ConfessionalPanel: React.FC = () => {
  const thoughts = useThoughts();
  const agents = useAgents();
  const [filterAgentId, setFilterAgentId] = useState<string | null>(null);
  const [currentIdx, setCurrentIdx] = useState(0);

  const filteredThoughts = filterAgentId
    ? thoughts.filter(t => t.agentId === filterAgentId)
    : thoughts;

  // Auto-cycle through thoughts every 8 seconds
  useEffect(() => {
    if (filteredThoughts.length <= 1) return;
    const interval = setInterval(() => {
      setCurrentIdx(prev => (prev + 1) % filteredThoughts.length);
    }, 8000);
    return () => clearInterval(interval);
  }, [filteredThoughts.length]);

  // Reset index when filter changes
  useEffect(() => {
    setCurrentIdx(Math.max(0, filteredThoughts.length - 1));
  }, [filterAgentId]);

  const currentThought = filteredThoughts[Math.min(currentIdx, filteredThoughts.length - 1)];

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: `radial-gradient(ellipse at center top, #2a1040 0%, #1a0a2e 40%, #0f0f23 100%)`,
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '16px 18px',
          borderBottom: `1px solid ${COLORS.border}`,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}
      >
        <span style={{ fontSize: '18px' }}>&#127909;</span>
        <span
          style={{
            fontFamily: FONTS.pixel,
            fontSize: '10px',
            color: '#a855f7',
            letterSpacing: 2,
          }}
        >
          CONFESSIONAL
        </span>
      </div>

      {/* Agent filter */}
      <div style={{ padding: '8px 18px' }}>
        <select
          value={filterAgentId || ''}
          onChange={e => setFilterAgentId(e.target.value || null)}
          style={{
            width: '100%',
            padding: '6px 10px',
            background: COLORS.bgCard,
            color: COLORS.text,
            border: `1px solid ${COLORS.border}`,
            borderRadius: 4,
            fontFamily: FONTS.body,
            fontSize: '13px',
          }}
        >
          <option value="">All Villagers</option>
          {agents.filter(a => a.alive !== false).map(a => (
            <option key={a.id} value={a.id}>{a.config.name}</option>
          ))}
        </select>
      </div>

      {/* Spotlight thought display */}
      {currentThought ? (
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '20px 24px',
            textAlign: 'center',
          }}
        >
          {/* Agent avatar */}
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: '50%',
              background: hexToString(nameToColor(currentThought.agentName)),
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '24px',
              fontWeight: 'bold',
              color: '#fff',
              marginBottom: 12,
              boxShadow: `0 0 20px ${hexToString(nameToColor(currentThought.agentName))}40`,
            }}
          >
            {currentThought.agentName[0]}
          </div>

          {/* Agent name */}
          <div
            style={{
              fontFamily: FONTS.pixel,
              fontSize: '11px',
              color: hexToString(nameToColor(currentThought.agentName)),
              marginBottom: 16,
            }}
          >
            {currentThought.agentName}
          </div>

          {/* Thought text */}
          <div
            style={{
              fontFamily: FONTS.body,
              fontSize: '16px',
              color: '#f3e8ff',
              lineHeight: 1.7,
              fontStyle: 'italic',
              maxWidth: 340,
            }}
          >
            &ldquo;{currentThought.thought}&rdquo;
          </div>

          {/* Timestamp */}
          <div
            style={{
              fontFamily: FONTS.body,
              fontSize: '11px',
              color: '#666',
              marginTop: 16,
            }}
          >
            {new Date(currentThought.timestamp).toLocaleTimeString()}
          </div>
        </div>
      ) : (
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: COLORS.textDim,
            fontFamily: FONTS.body,
            fontSize: '14px',
            fontStyle: 'italic',
          }}
        >
          Waiting for confessionals...
        </div>
      )}

      {/* Thought timeline */}
      <div
        style={{
          maxHeight: 200,
          overflowY: 'auto',
          borderTop: `1px solid ${COLORS.border}`,
        }}
      >
        {filteredThoughts.slice(-20).reverse().map((t, i) => (
          <div
            key={t.id}
            onClick={() => setCurrentIdx(filteredThoughts.length - 1 - i)}
            style={{
              padding: '10px 18px',
              borderBottom: `1px solid rgba(255,255,255,0.03)`,
              cursor: 'pointer',
              background: currentThought?.id === t.id ? 'rgba(168, 85, 247, 0.1)' : 'transparent',
            }}
          >
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <span
                style={{
                  fontFamily: FONTS.pixel,
                  fontSize: '8px',
                  color: hexToString(nameToColor(t.agentName)),
                  flexShrink: 0,
                  paddingTop: 2,
                }}
              >
                {t.agentName}
              </span>
              <span
                style={{
                  fontFamily: FONTS.body,
                  fontSize: '12px',
                  color: '#b0a0c0',
                  fontStyle: 'italic',
                  lineHeight: 1.4,
                }}
              >
                {t.thought.length > 100 ? t.thought.substring(0, 97) + '...' : t.thought}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
