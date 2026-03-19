import React, { useState, useEffect, useRef } from 'react';
import { COLORS, FONTS } from '../styles';
import { nameToColor, hexToString } from '../../utils/color';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CreatedAgent {
  id: string;
  name: string;
  occupation: string;
  soul: string;
}

interface SetupPageProps {
  onEnter: () => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MODELS = [
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5 (fast)' },
  { value: 'claude-sonnet-4-20250514', label: 'Sonnet 4 (balanced)' },
  { value: 'claude-opus-4-6', label: 'Opus 4.6 (smartest)' },
];

const ACCENT = '#64ffda';
const BG = '#050510';
const CARD_BG = '#0f0f23';
const INPUT_BG = '#1a1a2e';
const LABEL_COLOR = '#8888aa';
const BORDER_DIM = '#2a2a4a';

const SOUL_PLACEHOLDER = `Describe who this person is. Write freely — this text becomes their inner voice.

Example:
"I'm warm but guarded. I moved here after losing my restaurant in the city. I pour everything into my small cafe because it's my second chance. I talk to everyone but rarely share what I'm actually feeling. I admire people who are honest about their struggles. My biggest fear is failing again."

You can include:
- Personality and temperament
- Values and beliefs
- Communication style
- Fears, desires, contradictions
- How they relate to others`;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const SetupPage: React.FC<SetupPageProps> = ({ onEnter }) => {
  // --- Config state ---
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [model, setModel] = useState('claude-sonnet-4-20250514');
  const [configured, setConfigured] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(true);

  // --- Agent creator state ---
  const [name, setName] = useState('');
  const [age, setAge] = useState(30);
  const [occupation, setOccupation] = useState('');
  const [soul, setSoul] = useState('');
  const [createdAgents, setCreatedAgents] = useState<CreatedAgent[]>([]);
  const [addingAgent, setAddingAgent] = useState(false);

  // --- Stars ---
  const [stars] = useState(() =>
    Array.from({ length: 50 }, () => ({
      left: Math.random() * 100,
      top: Math.random() * 100,
      size: Math.random() > 0.85 ? 2 : 1,
      delay: Math.random() * 5,
      duration: 2 + Math.random() * 4,
    })),
  );

  const nameInputRef = useRef<HTMLInputElement>(null);
  const soulRef = useRef<HTMLTextAreaElement>(null);

  // --- Check server status on mount ---
  useEffect(() => {
    fetch('/api/config/status')
      .then((r) => r.json())
      .then((data) => {
        setConfigured(data.configured);
        if (data.agents && data.agents.length > 0) {
          setCreatedAgents(
            data.agents.map((a: any, i: number) => ({
              id: `existing-${i}`,
              name: a.name,
              occupation: a.occupation,
              soul: '',
            })),
          );
        }
        setChecking(false);
      })
      .catch(() => {
        setChecking(false);
        setError('Server not running. Start with: pnpm dev:server');
      });
  }, []);

  // --- Handlers ---

  const handleAddAgent = async () => {
    if (!name.trim()) {
      setError('Give your agent a name');
      nameInputRef.current?.focus();
      return;
    }
    if (!occupation.trim()) {
      setError('Give your agent an occupation');
      return;
    }

    setAddingAgent(true);
    setError('');

    try {
      const res = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          age,
          occupation: occupation.trim(),
          soul: soul.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to create agent');
        setAddingAgent(false);
        return;
      }

      setCreatedAgents((prev) => [
        ...prev,
        {
          id: data.agent?.id || `agent-${Date.now()}`,
          name: name.trim(),
          occupation: occupation.trim(),
          soul: soul.trim(),
        },
      ]);

      // Reset form
      setName('');
      setAge(30);
      setOccupation('');
      setSoul('');
      nameInputRef.current?.focus();
    } catch {
      setError('Cannot reach server');
    } finally {
      setAddingAgent(false);
    }
  };

  const handleEnter = async () => {
    setLoading(true);
    setError('');

    try {
      if (apiKey.trim()) {
        const res = await fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiKey: apiKey.trim(), model }),
        });
        const data = await res.json();
        if (!res.ok) {
          setError(data.error || 'Configuration failed');
          setLoading(false);
          return;
        }
      }
      onEnter();
    } catch {
      setError('Cannot reach server');
      setLoading(false);
    }
  };

  const canEnter = createdAgents.length > 0 && (apiKey.trim().length > 0 || configured);

  // --- Loading state ---
  if (checking) {
    return (
      <div
        style={{
          width: '100vw',
          height: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: BG,
          fontFamily: FONTS.pixel,
          color: LABEL_COLOR,
          fontSize: 9,
        }}
      >
        <span style={{ animation: 'pulse 1.5s ease-in-out infinite' }}>...</span>
      </div>
    );
  }

  // --- Main render ---
  return (
    <div
      style={{
        width: '100vw',
        minHeight: '100vh',
        background: BG,
        position: 'relative',
        overflowX: 'hidden',
        overflowY: 'auto',
      }}
    >
      <style>{`
        @keyframes twinkle {
          0%, 100% { opacity: 0.15; }
          50% { opacity: 0.9; }
        }
        @keyframes pulse {
          0%, 100% { opacity: 0.3; }
          50% { opacity: 1; }
        }
        @keyframes slideIn {
          from { opacity: 0; transform: translateY(20px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes glow {
          0%, 100% { text-shadow: 0 0 20px rgba(100, 255, 218, 0.2); }
          50% { text-shadow: 0 0 40px rgba(100, 255, 218, 0.4), 0 0 80px rgba(100, 255, 218, 0.1); }
        }
        .s-input:focus, .s-textarea:focus, .s-select:focus {
          outline: none;
          border-color: ${ACCENT} !important;
          box-shadow: 0 0 0 1px rgba(100, 255, 218, 0.12);
        }
        .s-input::placeholder, .s-textarea::placeholder { color: #3a3a5a; }
        .s-btn:hover:not(:disabled) {
          background: ${ACCENT} !important;
          color: ${BG} !important;
          box-shadow: 0 0 24px rgba(100, 255, 218, 0.2);
        }
        .s-btn:active:not(:disabled) { transform: scale(0.98); }
        .s-skip:hover { color: ${LABEL_COLOR} !important; }
        .s-show:hover { color: ${ACCENT} !important; }
        .s-card:hover { border-color: #3a3a5a !important; }
      `}</style>

      {/* Stars */}
      {stars.map((s, i) => (
        <div
          key={i}
          style={{
            position: 'fixed',
            left: `${s.left}%`,
            top: `${s.top}%`,
            width: s.size,
            height: s.size,
            borderRadius: '50%',
            background: '#fff',
            animation: `twinkle ${s.duration}s ease-in-out ${s.delay}s infinite`,
            pointerEvents: 'none',
          }}
        />
      ))}

      {/* Content */}
      <div
        style={{
          maxWidth: 640,
          margin: '0 auto',
          padding: '60px 24px 120px',
          position: 'relative',
          zIndex: 1,
        }}
      >
        {/* ── Header ──────────────────────────────────────────── */}
        <div style={{ textAlign: 'center', animation: 'slideIn 0.6s ease-out' }}>
          <h1
            style={{
              fontFamily: FONTS.pixel,
              fontSize: 32,
              color: COLORS.textAccent,
              margin: 0,
              letterSpacing: 6,
              animation: 'glow 4s ease-in-out infinite',
            }}
          >
            AI VILLAGE
          </h1>
          <div
            style={{
              width: 48,
              height: 2,
              background: ACCENT,
              margin: '18px auto 14px',
              opacity: 0.4,
            }}
          />
          <p
            style={{
              fontFamily: FONTS.pixel,
              fontSize: 8,
              color: COLORS.text,
              margin: 0,
              lineHeight: 2.2,
            }}
          >
            Write a soul. Watch it live.
          </p>
        </div>

        {/* ── API Config ──────────────────────────────────────── */}
        <div style={{ marginTop: 48, animation: 'slideIn 0.6s ease-out 0.1s backwards' }}>
          <div
            style={{
              fontFamily: FONTS.pixel,
              fontSize: 6,
              color: LABEL_COLOR,
              letterSpacing: 2,
              marginBottom: 10,
              textTransform: 'uppercase',
            }}
          >
            API Key
          </div>

          <div style={{ display: 'flex', gap: 10 }}>
            <div style={{ flex: 1, position: 'relative' }}>
              <input
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={configured ? 'Key found in .env' : 'sk-ant-api03-...'}
                className="s-input"
                style={{
                  width: '100%',
                  padding: '10px 52px 10px 12px',
                  fontFamily: 'monospace',
                  fontSize: 11,
                  color: COLORS.text,
                  background: INPUT_BG,
                  border: `1px solid ${configured && !apiKey ? COLORS.active + '44' : BORDER_DIM}`,
                  borderRadius: 4,
                  boxSizing: 'border-box',
                  transition: 'border-color 0.2s',
                }}
              />
              <button
                type="button"
                onClick={() => setShowKey(!showKey)}
                className="s-show"
                style={{
                  position: 'absolute',
                  right: 10,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  fontFamily: FONTS.pixel,
                  fontSize: 5,
                  color: BORDER_DIM,
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  transition: 'color 0.15s',
                }}
              >
                {showKey ? 'HIDE' : 'SHOW'}
              </button>
            </div>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="s-select s-input"
              style={{
                width: 180,
                padding: '10px 24px 10px 10px',
                fontFamily: FONTS.pixel,
                fontSize: 7,
                color: COLORS.text,
                background: INPUT_BG,
                border: `1px solid ${BORDER_DIM}`,
                borderRadius: 4,
                cursor: 'pointer',
                appearance: 'none',
                backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 10 10'%3E%3Cpath d='M2 4l3 3 3-3' stroke='%238888aa' fill='none' stroke-width='1.5'/%3E%3C/svg%3E")`,
                backgroundRepeat: 'no-repeat',
                backgroundPosition: 'right 8px center',
                flexShrink: 0,
              }}
            >
              {MODELS.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 5 }}>
            <a
              href="https://console.anthropic.com/settings/keys"
              target="_blank"
              rel="noreferrer"
              style={{ fontFamily: FONTS.pixel, fontSize: 5, color: BORDER_DIM, textDecoration: 'none' }}
            >
              Get a key
            </a>
            {configured && !apiKey && (
              <span style={{ fontFamily: FONTS.pixel, fontSize: 5, color: COLORS.active }}>
                .env configured
              </span>
            )}
          </div>
        </div>

        {/* ── Agent Creator ───────────────────────────────────── */}
        <div style={{ marginTop: 48, animation: 'slideIn 0.6s ease-out 0.2s backwards' }}>
          <div
            style={{
              fontFamily: FONTS.pixel,
              fontSize: 6,
              color: LABEL_COLOR,
              letterSpacing: 2,
              marginBottom: 16,
              textTransform: 'uppercase',
            }}
          >
            Create a Villager
          </div>

          <div
            style={{
              background: CARD_BG,
              border: `1px solid ${BORDER_DIM}`,
              borderRadius: 6,
              padding: 24,
            }}
          >
            {/* Name + Age row */}
            <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>NAME</label>
                <input
                  ref={nameInputRef}
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Yuki Tanaka"
                  className="s-input"
                  style={inputStyle}
                />
              </div>
              <div style={{ width: 70 }}>
                <label style={labelStyle}>AGE</label>
                <input
                  type="number"
                  value={age}
                  onChange={(e) => setAge(Math.max(1, Math.min(120, parseInt(e.target.value) || 30)))}
                  className="s-input"
                  style={{ ...inputStyle, textAlign: 'center' as const }}
                />
              </div>
            </div>

            {/* Occupation */}
            <div style={{ marginBottom: 20 }}>
              <label style={labelStyle}>OCCUPATION</label>
              <input
                type="text"
                value={occupation}
                onChange={(e) => setOccupation(e.target.value)}
                placeholder="Cafe owner"
                className="s-input"
                style={inputStyle}
              />
            </div>

            {/* Divider */}
            <div
              style={{
                height: 1,
                background: BORDER_DIM,
                margin: '4px 0 20px',
                opacity: 0.5,
              }}
            />

            {/* Soul */}
            <div style={{ marginBottom: 20 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <label style={{ ...labelStyle, marginBottom: 0, color: ACCENT, fontSize: 7 }}>
                  SOUL
                </label>
                <span style={{ fontFamily: FONTS.pixel, fontSize: 5, color: BORDER_DIM }}>
                  {soul.length}/2000
                </span>
              </div>
              <textarea
                ref={soulRef}
                value={soul}
                onChange={(e) => setSoul(e.target.value.slice(0, 2000))}
                placeholder={SOUL_PLACEHOLDER}
                rows={10}
                className="s-textarea"
                style={{
                  width: '100%',
                  padding: '14px 14px',
                  fontFamily: '"Press Start 2P", monospace',
                  fontSize: 7,
                  color: COLORS.text,
                  background: '#0a0a1a',
                  border: `1px solid ${BORDER_DIM}`,
                  borderRadius: 4,
                  boxSizing: 'border-box' as const,
                  resize: 'vertical' as const,
                  lineHeight: 2.4,
                  transition: 'border-color 0.2s',
                }}
              />
              <p
                style={{
                  fontFamily: FONTS.pixel,
                  fontSize: 5,
                  color: BORDER_DIM,
                  margin: '6px 0 0',
                  lineHeight: 2,
                }}
              >
                This text is injected into the agent's mind. It shapes how they think, speak, and act.
              </p>
            </div>

            {/* Error */}
            {error && (
              <div
                style={{
                  fontFamily: FONTS.pixel,
                  fontSize: 7,
                  color: COLORS.warning,
                  marginBottom: 14,
                  padding: '8px 10px',
                  background: 'rgba(255,80,80,0.06)',
                  border: '1px solid rgba(255,80,80,0.15)',
                  borderRadius: 4,
                }}
              >
                {error}
              </div>
            )}

            {/* Add Agent */}
            <button
              type="button"
              onClick={handleAddAgent}
              disabled={addingAgent}
              className="s-btn"
              style={{
                width: '100%',
                padding: '12px 0',
                fontFamily: FONTS.pixel,
                fontSize: 9,
                color: addingAgent ? BORDER_DIM : ACCENT,
                background: 'transparent',
                border: `1px solid ${addingAgent ? BORDER_DIM : ACCENT}`,
                borderRadius: 4,
                cursor: addingAgent ? 'wait' : 'pointer',
                letterSpacing: 3,
                transition: 'all 0.15s',
              }}
            >
              {addingAgent ? 'CREATING...' : '+ CREATE AGENT'}
            </button>
          </div>
        </div>

        {/* ── Agent Roster ────────────────────────────────────── */}
        <div style={{ marginTop: 36, animation: 'slideIn 0.6s ease-out 0.35s backwards' }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 12,
            }}
          >
            <span
              style={{
                fontFamily: FONTS.pixel,
                fontSize: 6,
                color: LABEL_COLOR,
                letterSpacing: 2,
                textTransform: 'uppercase',
              }}
            >
              Villagers
            </span>
            <span
              style={{
                fontFamily: FONTS.pixel,
                fontSize: 6,
                color: createdAgents.length > 0 ? ACCENT : BORDER_DIM,
              }}
            >
              {createdAgents.length}
            </span>
          </div>

          {createdAgents.length === 0 ? (
            <div
              style={{
                fontFamily: FONTS.pixel,
                fontSize: 7,
                color: BORDER_DIM,
                textAlign: 'center',
                padding: '20px 0',
                border: `1px dashed ${BORDER_DIM}`,
                borderRadius: 6,
                lineHeight: 2,
              }}
            >
              No villagers yet
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {createdAgents.map((agent) => {
                const color = hexToString(nameToColor(agent.name));
                return (
                  <div
                    key={agent.id}
                    className="s-card"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      padding: '10px 14px',
                      background: CARD_BG,
                      border: `1px solid ${BORDER_DIM}`,
                      borderRadius: 5,
                      transition: 'border-color 0.15s',
                    }}
                  >
                    <div
                      style={{
                        width: 32,
                        height: 32,
                        borderRadius: '50%',
                        background: `radial-gradient(circle at 35% 35%, ${color}, ${color}88)`,
                        border: '2px solid rgba(255,255,255,0.08)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontFamily: FONTS.pixel,
                        fontSize: 12,
                        color: '#fff',
                        textShadow: '1px 1px 2px rgba(0,0,0,0.5)',
                        flexShrink: 0,
                      }}
                    >
                      {agent.name.charAt(0)}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontFamily: FONTS.pixel, fontSize: 8, color: COLORS.text }}>
                        {agent.name}
                      </div>
                      <div style={{ fontFamily: FONTS.pixel, fontSize: 6, color: LABEL_COLOR, marginTop: 2 }}>
                        {agent.occupation}
                      </div>
                    </div>
                    {agent.soul && (
                      <div
                        style={{
                          fontFamily: FONTS.pixel,
                          fontSize: 5,
                          color: BORDER_DIM,
                          maxWidth: 180,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {agent.soul.slice(0, 60)}...
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* ── Enter ───────────────────────────────────────────── */}
        <div
          style={{
            marginTop: 44,
            textAlign: 'center',
            animation: 'slideIn 0.6s ease-out 0.5s backwards',
          }}
        >
          <button
            type="button"
            onClick={handleEnter}
            disabled={!canEnter || loading}
            className="s-btn"
            style={{
              width: '100%',
              maxWidth: 380,
              padding: '14px 0',
              fontFamily: FONTS.pixel,
              fontSize: 11,
              color: !canEnter || loading ? BORDER_DIM : ACCENT,
              background: 'transparent',
              border: `2px solid ${!canEnter || loading ? BORDER_DIM : ACCENT}`,
              borderRadius: 4,
              cursor: !canEnter || loading ? 'not-allowed' : 'pointer',
              letterSpacing: 4,
              transition: 'all 0.2s',
              opacity: !canEnter ? 0.5 : 1,
            }}
          >
            {loading ? 'CONNECTING...' : 'ENTER THE VILLAGE'}
          </button>

          <button
            type="button"
            onClick={() => onEnter()}
            className="s-skip"
            style={{
              display: 'block',
              width: '100%',
              marginTop: 12,
              padding: '8px 0',
              fontFamily: FONTS.pixel,
              fontSize: 6,
              color: BORDER_DIM,
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              transition: 'color 0.15s',
              textAlign: 'center',
            }}
          >
            WATCH WITHOUT AI
          </button>

          <p
            style={{
              fontFamily: FONTS.pixel,
              fontSize: 5,
              color: BORDER_DIM,
              marginTop: 20,
              lineHeight: 2.2,
              opacity: 0.5,
            }}
          >
            Your key stays server-side. Never stored to disk.
          </p>
        </div>
      </div>

      {/* Village silhouette */}
      <svg
        viewBox="0 0 1400 80"
        preserveAspectRatio="none"
        style={{
          position: 'fixed',
          bottom: 0,
          left: 0,
          width: '100%',
          height: 50,
          zIndex: 0,
          pointerEvents: 'none',
        }}
      >
        <path
          d="M0,80 L0,55 L30,55 L30,40 L38,33 L46,40 L46,55 L80,55 L80,48 L88,42 L96,48 L96,55 L150,55 L150,35 L160,27 L170,35 L170,55 L220,55 L220,50 L230,50 L230,38 L238,32 L246,38 L246,50 L256,50 L256,55 L310,55 L310,42 L320,35 L330,42 L330,55 L380,55 L380,50 L395,50 L395,38 L405,30 L415,38 L415,50 L430,50 L430,55 L500,55 L500,45 L510,38 L520,45 L520,55 L560,55 L560,50 L575,50 L575,35 L585,27 L595,35 L595,50 L610,50 L610,55 L670,55 L670,48 L678,42 L686,48 L686,55 L730,55 L730,40 L740,32 L750,40 L750,55 L800,55 L800,50 L810,45 L820,50 L820,55 L870,55 L870,48 L880,40 L890,48 L890,55 L940,55 L940,50 L950,42 L960,50 L960,55 L1010,55 L1010,45 L1020,38 L1030,45 L1030,55 L1080,55 L1080,50 L1090,50 L1090,38 L1100,30 L1110,38 L1110,50 L1120,50 L1120,55 L1180,55 L1180,48 L1190,42 L1200,48 L1200,55 L1260,55 L1260,42 L1270,35 L1280,42 L1280,55 L1340,55 L1340,50 L1350,44 L1360,50 L1360,55 L1400,55 L1400,80 Z"
          fill="#060610"
        />
        <path d="M60,55 L55,38 L65,38 Z" fill="#080815" />
        <path d="M190,55 L184,35 L196,35 Z" fill="#080815" />
        <path d="M350,55 L344,38 L356,38 Z" fill="#080815" />
        <path d="M470,55 L464,36 L476,36 Z" fill="#080815" />
        <path d="M640,55 L634,38 L646,38 Z" fill="#080815" />
        <path d="M770,55 L764,35 L776,35 Z" fill="#080815" />
        <path d="M910,55 L904,38 L916,38 Z" fill="#080815" />
        <path d="M1050,55 L1044,36 L1056,36 Z" fill="#080815" />
        <path d="M1230,55 L1224,38 L1236,38 Z" fill="#080815" />
      </svg>
    </div>
  );
};

// --- Shared styles ---

const labelStyle: React.CSSProperties = {
  fontFamily: '"Press Start 2P", monospace',
  fontSize: 6,
  color: '#8888aa',
  display: 'block',
  marginBottom: 6,
  letterSpacing: 1,
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  fontFamily: '"Press Start 2P", monospace',
  fontSize: 8,
  color: '#e0e0e0',
  background: '#1a1a2e',
  border: '1px solid #2a2a4a',
  borderRadius: 4,
  boxSizing: 'border-box',
  transition: 'border-color 0.2s',
};
