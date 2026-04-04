import React, { useState, useEffect, useRef } from 'react';
import { useIsMobile } from '../../core/hooks';
import { COLORS, FONTS } from '../styles';
import { useTheme } from '../ThemeContext';
import { nameToColor, hexToString } from '../../utils/color';
import { getToken, setToken, clearToken, authHeaders, setUserId, setEmail } from '../../utils/auth';
import { type CharacterModel } from '../../game/data/sprite-config';
import { CharacterPicker } from './CharacterPicker';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CreatedAgent {
  id: string;
  name: string;
  occupation?: string;
  soul: string;
  startingGold: number;
}

interface SetupPageProps {
  onEnter: () => void;
  onBack?: () => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MODELS = [
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5 (fast)' },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6 (balanced)' },
  { value: 'claude-opus-4-6', label: 'Opus 4.6 (smartest)' },
];

const ACCENT = '#2a8a6a';
const BG = '#f5f5f0';
const CARD_BG = '#ffffff';
const INPUT_BG = '#eeeee8';
const LABEL_COLOR = '#777770';
const BORDER_DIM = '#d0d0c8';

const SOUL_PLACEHOLDER = `Write their inner voice. This is who they are — how they think, speak, and act.

Example:
"I'm warm but guarded. I moved here after losing everything in the city. I talk to everyone but rarely share what I'm actually feeling. I want to be trusted, but I'm terrified of being vulnerable again."`;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const SetupPage: React.FC<SetupPageProps> = ({ onEnter, onBack }) => {
  const { colors } = useTheme();
  const isMobile = useIsMobile();
  // --- Auth state ---
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authMode, setAuthMode] = useState<'login' | 'signup'>('signup');
  const [authLoading, setAuthLoading] = useState(false);
  const [user, setUser] = useState<{ id: string; email: string } | null>(null);

  // --- Config state ---
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [model, setModel] = useState('claude-sonnet-4-6');
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(true);

  // --- Agent creator state ---
  const [name, setName] = useState('');
  const [spriteId, setSpriteId] = useState<CharacterModel>('astronaut');
  const [age, setAge] = useState(30);
  const [occupation, setOccupation] = useState('');
  const [backstory, setBackstory] = useState('');
  const [goal, setGoal] = useState('');
  const [startingGold, setStartingGold] = useState(0);
  const [soul, setSoul] = useState('');
  const [personality, setPersonality] = useState({
    openness: 50, conscientiousness: 50, extraversion: 50,
    agreeableness: 50, neuroticism: 50,
  });
  const [showPersonality, setShowPersonality] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [fears, setFears] = useState('');
  const [desires, setDesires] = useState('');
  const [coreValues, setCoreValues] = useState('');
  const [contradictions, setContradictions] = useState('');
  const [speechPattern, setSpeechPattern] = useState('');
  const [createdAgents, setCreatedAgents] = useState<CreatedAgent[]>([]);
  const [addingAgent, setAddingAgent] = useState(false);
  const [deletingAgent, setDeletingAgent] = useState<string | null>(null);

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

  // --- Check server status + existing auth on mount ---
  useEffect(() => {
    const init = async () => {
      // Check if we have a valid token, or if server is in dev mode (no Cognito)
      try {
        const authRes = await fetch('/api/auth/me', {
          headers: getToken() ? { Authorization: `Bearer ${getToken()}` } : {},
        });
        if (authRes.ok) {
          const authData = await authRes.json();
          setUser(authData.user);
          if (authData.user?.id) {
            setUserId(authData.user.id);
            // In dev mode, set a dummy token so auth headers work
            if (!getToken()) setToken('dev-token');
          }
        } else {
          clearToken();
        }
      } catch {
        clearToken();
      }

      // Load existing agents
      try {
        const res = await fetch('/api/config/status');
        if (!res.ok) throw new Error(`Server returned ${res.status}`);
        const data = await res.json();
        if (data.agents && data.agents.length > 0) {
          setCreatedAgents(
            data.agents.map((a: any, i: number) => ({
              id: a.id || `existing-${i}`,
              name: a.name,
              occupation: a.occupation,
              soul: a.soul || '',
              startingGold: a.currency ?? 100,
            })),
          );
        }
      } catch {
        setError('Server not running. Start with: pnpm dev:server');
      }
      setChecking(false);
    };
    init();
  }, []);

  // --- Handlers ---

  const handleAuth = async () => {
    if (!authEmail.trim() || !authPassword) {
      setError('Email and password required');
      return;
    }
    setAuthLoading(true);
    setError('');
    try {
      const endpoint = authMode === 'signup' ? '/api/auth/signup' : '/api/auth/login';
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: authEmail.trim(), password: authPassword }),
      });
      // Parse JSON after status check — avoids unhandled throw if server returns
      // a non-JSON body on error (e.g. HTML 502 from proxy, empty 5xx from ALB).
      let data: { token?: string; user?: { id: string; email: string }; error?: string } = {};
      try { data = await res.json(); } catch { /* non-JSON body — fall through */ }
      if (!res.ok) {
        setError(data.error || `Authentication failed (${res.status})`);
        setAuthLoading(false);
        return;
      }
      if (data.token) {
        setToken(data.token);
        if (data.user?.id) setUserId(data.user.id);
        if (data.user?.email) setEmail(data.user.email);
        setUser(data.user ?? null);
      } else {
        // Signup succeeded but no token — switch to login
        setAuthMode('login');
        setError('Account created. Please log in.');
      }
    } catch {
      setError('Cannot reach server');
    } finally {
      setAuthLoading(false);
    }
  };

  const handleLogout = async () => {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: authHeaders(),
      });
    } catch {
      // Best-effort: clear local state even if server call fails
    }
    clearToken();
    setUser(null);
    setAuthEmail('');
    setAuthPassword('');
  };

  const handleAddAgent = async () => {
    if (addingAgent) return; // prevent double-submit while request is in flight
    if (!name.trim()) {
      setError('Give your agent a name');
      nameInputRef.current?.focus();
      return;
    }
    if (!user) {
      setError('Sign in first to create an agent');
      return;
    }
    if (!apiKey.trim()) {
      setError('Enter your API key — it powers your agent\'s thinking');
      return;
    }

    setAddingAgent(true);
    setError('');

    try {
      // BYOK: send API key + model with each agent creation (auth required)
      const res = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({
          name: name.trim(),
          spriteId,
          age,
          occupation: occupation.trim(),
          backstory: backstory.trim(),
          goal: goal.trim(),
          startingGold,
          soul: soul.trim(),
          apiKey: apiKey.trim(),
          model,
          personality: {
            openness: personality.openness / 100,
            conscientiousness: personality.conscientiousness / 100,
            extraversion: personality.extraversion / 100,
            agreeableness: personality.agreeableness / 100,
            neuroticism: personality.neuroticism / 100,
          },
          fears: fears.trim() ? fears.split(',').map(s => s.trim()).filter(Boolean) : undefined,
          desires: desires.trim() ? desires.split(',').map(s => s.trim()).filter(Boolean) : undefined,
          coreValues: coreValues.trim() ? coreValues.split(',').map(s => s.trim()).filter(Boolean) : undefined,
          contradictions: contradictions.trim() || undefined,
          speechPattern: speechPattern.trim() || undefined,
        }),
      });
      let data: { agent?: { id: string }; error?: string } = {};
      try { data = await res.json(); } catch { /* non-JSON body */ }
      if (!res.ok) {
        setError(data.error || `Failed to create agent (${res.status})`);
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
          startingGold,
        },
      ]);

      // Reset form
      setName('');
      setSpriteId('astronaut');
      setAge(30);
      setOccupation('');
      setBackstory('');
      setGoal('');
      setStartingGold(0);
      setSoul('');
      setPersonality({ openness: 50, conscientiousness: 50, extraversion: 50, agreeableness: 50, neuroticism: 50 });
      setShowPersonality(false);
      setShowAdvanced(false);
      setFears('');
      setDesires('');
      setCoreValues('');
      setContradictions('');
      setSpeechPattern('');
      nameInputRef.current?.focus();
    } catch {
      setError('Cannot reach server');
    } finally {
      setAddingAgent(false);
    }
  };

  const handleEnter = () => {
    onEnter();
  };

  const handleDeleteAgent = async (agentId: string) => {
    if (deletingAgent) return;
    if (!confirm('Remove this villager from the world?')) return;

    setDeletingAgent(agentId);
    try {
      const res = await fetch(`/api/agents/${agentId}`, { method: 'DELETE', headers: authHeaders() });
      if (res.ok) {
        setCreatedAgents((prev) => prev.filter((a) => a.id !== agentId));
      } else {
        const data = await res.json();
        setError(data.error || 'Failed to delete agent');
      }
    } catch {
      setError('Cannot reach server');
    } finally {
      setDeletingAgent(null);
    }
  };

  const canEnter = createdAgents.length > 0;

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
        .s-input::placeholder, .s-textarea::placeholder { color: #999990; }
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
          padding: isMobile ? '20px 16px 80px' : '60px 24px 120px',
          position: 'relative',
          zIndex: 1,
        }}
      >
        {/* ── Back to Maps ──────────────────────────────────── */}
        {onBack && (
          <button
            onClick={onBack}
            style={{
              position: 'absolute',
              top: 20,
              left: 24,
              padding: '6px 14px',
              background: 'transparent',
              border: `1px solid ${colors.border}`,
              borderRadius: 4,
              cursor: 'pointer',
              color: colors.textDim,
              fontFamily: FONTS.pixel,
              fontSize: '7px',
              letterSpacing: 1,
              zIndex: 10,
              transition: 'border-color .2s, color .2s',
            }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = colors.accent; e.currentTarget.style.color = colors.accent; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = colors.border; e.currentTarget.style.color = colors.textDim; }}
          >
            &larr; MAPS
          </button>
        )}

        {/* ── Header ──────────────────────────────────────────── */}
        <div style={{ textAlign: 'center', animation: 'slideIn 0.6s ease-out' }}>
          <h1
            style={{
              fontFamily: FONTS.pixel,
              fontSize: 32,
              color: colors.textAccent,
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
              color: colors.text,
              margin: 0,
              lineHeight: 2.2,
            }}
          >
            Write a soul. Watch it live.
          </p>
        </div>

        {/* ── Auth ───────────────────────────────────────────── */}
        <div style={{ marginTop: 48, animation: 'slideIn 0.6s ease-out 0.1s backwards' }}>
          {user ? (
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '10px 16px',
                background: CARD_BG,
                border: `1px solid ${BORDER_DIM}`,
                borderRadius: 4,
              }}
            >
              <span style={{ fontFamily: FONTS.pixel, fontSize: 7, color: colors.text }}>
                {user.email}
              </span>
              <button
                type="button"
                onClick={handleLogout}
                className="s-show"
                style={{
                  fontFamily: FONTS.pixel,
                  fontSize: 5,
                  color: BORDER_DIM,
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  transition: 'color 0.15s',
                }}
              >
                SIGN OUT
              </button>
            </div>
          ) : (
            <div
              style={{
                background: CARD_BG,
                border: `1px solid ${BORDER_DIM}`,
                borderRadius: 6,
                padding: 20,
              }}
            >
              <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
                <button
                  type="button"
                  onClick={() => { setAuthMode('signup'); setError(''); }}
                  style={{
                    fontFamily: FONTS.pixel,
                    fontSize: 7,
                    color: authMode === 'signup' ? ACCENT : BORDER_DIM,
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    borderBottom: authMode === 'signup' ? `1px solid ${ACCENT}` : '1px solid transparent',
                    paddingBottom: 4,
                  }}
                >
                  SIGN UP
                </button>
                <button
                  type="button"
                  onClick={() => { setAuthMode('login'); setError(''); }}
                  style={{
                    fontFamily: FONTS.pixel,
                    fontSize: 7,
                    color: authMode === 'login' ? ACCENT : BORDER_DIM,
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    borderBottom: authMode === 'login' ? `1px solid ${ACCENT}` : '1px solid transparent',
                    paddingBottom: 4,
                  }}
                >
                  LOG IN
                </button>
              </div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                <input
                  type="email"
                  value={authEmail}
                  onChange={(e) => setAuthEmail(e.target.value)}
                  placeholder="email"
                  className="s-input"
                  style={{ ...inputStyle, flex: 1 }}
                  onKeyDown={(e) => e.key === 'Enter' && handleAuth()}
                />
                <input
                  type="password"
                  value={authPassword}
                  onChange={(e) => setAuthPassword(e.target.value)}
                  placeholder="password"
                  className="s-input"
                  style={{ ...inputStyle, flex: 1 }}
                  onKeyDown={(e) => e.key === 'Enter' && handleAuth()}
                />
              </div>
              <button
                type="button"
                onClick={handleAuth}
                disabled={authLoading}
                className="s-btn"
                style={{
                  width: '100%',
                  padding: '10px 0',
                  fontFamily: FONTS.pixel,
                  fontSize: 8,
                  color: authLoading ? BORDER_DIM : ACCENT,
                  background: 'transparent',
                  border: `1px solid ${authLoading ? BORDER_DIM : ACCENT}`,
                  borderRadius: 4,
                  cursor: authLoading ? 'wait' : 'pointer',
                  letterSpacing: 2,
                  transition: 'all 0.15s',
                }}
              >
                {authLoading ? '...' : authMode === 'signup' ? 'CREATE ACCOUNT' : 'LOG IN'}
              </button>
            </div>
          )}
        </div>

        {/* ── API Config ──────────────────────────────────────── */}
        <div style={{ marginTop: 24, animation: 'slideIn 0.6s ease-out 0.15s backwards' }}>
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
                placeholder="sk-ant-api03-..."
                className="s-input"
                style={{
                  width: '100%',
                  padding: '10px 52px 10px 12px',
                  fontFamily: 'monospace',
                  fontSize: 11,
                  color: colors.text,
                  background: INPUT_BG,
                  border: `1px solid ${BORDER_DIM}`,
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
                color: colors.text,
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
          <div style={{ marginTop: 5 }}>
            <a
              href="https://console.anthropic.com/settings/keys"
              target="_blank"
              rel="noreferrer"
              style={{ fontFamily: FONTS.pixel, fontSize: 5, color: BORDER_DIM, textDecoration: 'none' }}
            >
              Get a key
            </a>
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
            {/* Character picker + Name/Age */}
            <div style={{ display: 'flex', gap: 16, marginBottom: 14, alignItems: 'flex-start' }}>
              <CharacterPicker
                value={spriteId}
                onChange={setSpriteId}
                accentColor={ACCENT}
                labelColor={LABEL_COLOR}
                bgColor={INPUT_BG}
              />
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div>
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
                <div style={{ display: 'flex', gap: 10 }}>
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
              </div>
            </div>

            {/* Soul */}
            <div style={{ marginBottom: 18 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <label style={{ ...labelStyle, marginBottom: 0, color: ACCENT, fontSize: 7 }}>SOUL</label>
                <span style={{ fontFamily: FONTS.pixel, fontSize: 5, color: BORDER_DIM }}>{soul.length}/2000</span>
              </div>
              <textarea
                ref={soulRef}
                value={soul}
                onChange={(e) => setSoul(e.target.value.slice(0, 2000))}
                placeholder={SOUL_PLACEHOLDER}
                rows={12}
                className="s-textarea"
                style={{
                  width: '100%',
                  padding: '14px 14px',
                  fontFamily: '"Press Start 2P", monospace',
                  fontSize: 7,
                  color: '#333330',
                  background: INPUT_BG,
                  border: `1px solid ${BORDER_DIM}`,
                  borderRadius: 4,
                  boxSizing: 'border-box' as const,
                  resize: 'vertical' as const,
                  lineHeight: 2.4,
                  transition: 'border-color 0.2s',
                }}
              />
            </div>

            {/* Error */}
            {error && (
              <div
                style={{
                  fontFamily: FONTS.pixel,
                  fontSize: 7,
                  color: colors.warning,
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
                      <div style={{ fontFamily: FONTS.pixel, fontSize: 8, color: colors.text }}>
                        {agent.name}
                      </div>
                      <div style={{ fontFamily: FONTS.pixel, fontSize: 6, color: LABEL_COLOR, marginTop: 2 }}>
                        {agent.soul ? agent.soul.slice(0, 40) + (agent.soul.length > 40 ? '...' : '') : 'no soul written'}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleDeleteAgent(agent.id)}
                      disabled={deletingAgent === agent.id}
                      className="s-show"
                      style={{
                        fontFamily: FONTS.pixel,
                        fontSize: 8,
                        color: deletingAgent === agent.id ? BORDER_DIM : '#664444',
                        background: 'none',
                        border: 'none',
                        cursor: deletingAgent === agent.id ? 'wait' : 'pointer',
                        padding: '4px 6px',
                        transition: 'color 0.15s',
                        flexShrink: 0,
                      }}
                      title="Remove from village"
                    >
                      {deletingAgent === agent.id ? '...' : '\u00D7'}
                    </button>
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
            disabled={!canEnter}
            className="s-btn"
            style={{
              width: '100%',
              maxWidth: 380,
              padding: '14px 0',
              fontFamily: FONTS.pixel,
              fontSize: 11,
              color: !canEnter ? BORDER_DIM : ACCENT,
              background: 'transparent',
              border: `2px solid ${!canEnter ? BORDER_DIM : ACCENT}`,
              borderRadius: 4,
              cursor: !canEnter ? 'not-allowed' : 'pointer',
              letterSpacing: 4,
              transition: 'all 0.2s',
              opacity: !canEnter ? 0.5 : 1,
            }}
          >
            ENTER THE VILLAGE
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
            Your key powers only your agents. Stored encrypted server-side.
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
  color: LABEL_COLOR,
  display: 'block',
  marginBottom: 6,
  letterSpacing: 1,
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  fontFamily: '"Press Start 2P", monospace',
  fontSize: 8,
  color: '#333330',
  background: INPUT_BG,
  border: `1px solid ${BORDER_DIM}`,
  borderRadius: 4,
  boxSizing: 'border-box',
  transition: 'border-color 0.2s',
};
