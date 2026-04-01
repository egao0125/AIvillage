import React, { useState } from 'react';
import { FONTS } from '../styles';
import { authHeaders } from '../../utils/auth';

const ACCENT = '#64ffda';
const INPUT_BG = '#1a1a2e';
const BORDER_DIM = '#2a2a4a';
const LABEL_COLOR = '#8888aa';
const BG = '#050510';

const MODELS = [
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5 (fast)' },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6 (balanced)' },
  { value: 'claude-opus-4-6', label: 'Opus 4.6 (smartest)' },
];

const SOUL_PLACEHOLDER = `Write their inner voice. This is who they are — how they think, speak, and act.\n\nExample:\n"I'm warm but guarded. I moved here after losing everything in the city. I talk to everyone but rarely share what I'm actually feeling. I want to be trusted, but I'm terrified of being vulnerable again."`;

interface AgentFormProps {
  apiKey: string;
  model: string;
  onApiKeyChange: (key: string) => void;
  onModelChange: (model: string) => void;
  onCreated: (agent: { id: string; name: string; occupation?: string; soul: string; startingGold: number }) => void;
  onError: (msg: string) => void;
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  fontFamily: FONTS.pixel,
  fontSize: 7,
  color: '#e0e0e0',
  background: INPUT_BG,
  border: `1px solid ${BORDER_DIM}`,
  borderRadius: 4,
  boxSizing: 'border-box',
  transition: 'border-color 0.2s',
  lineHeight: 2.2,
};

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontFamily: FONTS.pixel,
  fontSize: 6,
  color: LABEL_COLOR,
  letterSpacing: 1,
  marginBottom: 6,
};

const defaultPersonality = {
  openness: 50,
  conscientiousness: 50,
  extraversion: 50,
  agreeableness: 50,
  neuroticism: 50,
};

export const AgentForm: React.FC<AgentFormProps> = ({
  apiKey,
  model,
  onApiKeyChange,
  onModelChange,
  onCreated,
  onError,
}) => {
  const [name, setName] = useState('');
  const [age, setAge] = useState(30);
  const [occupation, setOccupation] = useState('');
  const [personality, setPersonality] = useState({ ...defaultPersonality });
  const [soul, setSoul] = useState('');
  const [backstory, setBackstory] = useState('');
  const [goal, setGoal] = useState('');
  const [startingGold, setStartingGold] = useState(100);
  const [fears, setFears] = useState('');
  const [desires, setDesires] = useState('');
  const [coreValues, setCoreValues] = useState('');
  const [contradictions, setContradictions] = useState('');
  const [speechPattern, setSpeechPattern] = useState('');
  const [showPersonality, setShowPersonality] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [addingAgent, setAddingAgent] = useState(false);

  const resetForm = () => {
    setName('');
    setAge(30);
    setOccupation('');
    setPersonality({ ...defaultPersonality });
    setSoul('');
    setBackstory('');
    setGoal('');
    setStartingGold(100);
    setFears('');
    setDesires('');
    setCoreValues('');
    setContradictions('');
    setSpeechPattern('');
    setShowPersonality(false);
    setShowAdvanced(false);
  };

  const handleSubmit = async () => {
    if (!name.trim() || !soul.trim()) {
      onError('Name and Soul are required.');
      return;
    }
    setAddingAgent(true);
    try {
      const body = {
        name: name.trim(),
        age,
        occupation: occupation.trim() || undefined,
        backstory: backstory.trim() || undefined,
        goal: goal.trim() || undefined,
        startingGold,
        soul: soul.trim(),
        apiKey,
        model,
        personality: {
          openness: personality.openness / 100,
          conscientiousness: personality.conscientiousness / 100,
          extraversion: personality.extraversion / 100,
          agreeableness: personality.agreeableness / 100,
          neuroticism: personality.neuroticism / 100,
        },
        fears: fears.trim() ? fears.split(',').map((s) => s.trim()).filter(Boolean) : [],
        desires: desires.trim() ? desires.split(',').map((s) => s.trim()).filter(Boolean) : [],
        coreValues: coreValues.trim() ? coreValues.split(',').map((s) => s.trim()).filter(Boolean) : [],
        contradictions: contradictions.trim() || undefined,
        speechPattern: speechPattern.trim() || undefined,
      };

      const res = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error || `Failed to create agent (${res.status})`);
      }

      const agent = await res.json() as { id: string; name: string; occupation?: string; soul: string; startingGold: number };
      onCreated(agent);
      resetForm();
    } catch (err: unknown) {
      onError(err instanceof Error ? err.message : 'Failed to create agent');
    } finally {
      setAddingAgent(false);
    }
  };

  const sliderTraits: { key: keyof typeof defaultPersonality; low: string; high: string }[] = [
    { key: 'openness', low: 'Traditional', high: 'Creative' },
    { key: 'conscientiousness', low: 'Spontaneous', high: 'Disciplined' },
    { key: 'extraversion', low: 'Introverted', high: 'Extraverted' },
    { key: 'agreeableness', low: 'Competitive', high: 'Cooperative' },
    { key: 'neuroticism', low: 'Calm', high: 'Anxious' },
  ];

  const toggleStyle: React.CSSProperties = {
    background: 'none',
    border: `1px solid ${BORDER_DIM}`,
    borderRadius: 4,
    padding: '6px 12px',
    fontFamily: FONTS.pixel,
    fontSize: 7,
    color: LABEL_COLOR,
    cursor: 'pointer',
    letterSpacing: 1,
    width: '100%',
    textAlign: 'left',
  };

  return (
    <div>
      <style>{`
        .af-input:focus { outline: none; border-color: #64ffda !important; }
        .af-btn:hover:not(:disabled) { background: #64ffda !important; color: #050510 !important; }
      `}</style>

      {/* API Key + Model row */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>API KEY</label>
          <input
            className="af-input"
            type="password"
            value={apiKey}
            onChange={(e) => onApiKeyChange(e.target.value)}
            placeholder="sk-ant-..."
            style={inputStyle}
          />
        </div>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>MODEL</label>
          <select
            className="af-input"
            value={model}
            onChange={(e) => onModelChange(e.target.value)}
            style={{ ...inputStyle, cursor: 'pointer' }}
          >
            {MODELS.map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Name + Age row */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
        <div style={{ flex: 2 }}>
          <label style={labelStyle}>NAME *</label>
          <input
            className="af-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Agent name"
            style={inputStyle}
            maxLength={50}
          />
        </div>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>AGE</label>
          <input
            className="af-input"
            type="number"
            value={age}
            onChange={(e) => setAge(Math.max(1, Math.min(120, Number(e.target.value) || 1)))}
            min={1}
            max={120}
            style={inputStyle}
          />
        </div>
      </div>

      {/* PERSONALITY toggle */}
      <div style={{ marginBottom: 12 }}>
        <button
          style={toggleStyle}
          onClick={() => setShowPersonality(!showPersonality)}
        >
          {showPersonality ? '▾' : '▸'} PERSONALITY
        </button>
        {showPersonality && (
          <div style={{ padding: '12px 0' }}>
            {sliderTraits.map(({ key, low, high }) => (
              <div key={key} style={{ marginBottom: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                  <span style={{ fontFamily: FONTS.pixel, fontSize: 6, color: LABEL_COLOR }}>{low}</span>
                  <span style={{ fontFamily: FONTS.pixel, fontSize: 6, color: LABEL_COLOR }}>
                    {key.toUpperCase()} ({personality[key]})
                  </span>
                  <span style={{ fontFamily: FONTS.pixel, fontSize: 6, color: LABEL_COLOR }}>{high}</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={personality[key]}
                  onChange={(e) => setPersonality({ ...personality, [key]: Number(e.target.value) })}
                  style={{ width: '100%', accentColor: ACCENT }}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* DEEP IDENTITY toggle */}
      <div style={{ marginBottom: 12 }}>
        <button
          style={toggleStyle}
          onClick={() => setShowAdvanced(!showAdvanced)}
        >
          {showAdvanced ? '▾' : '▸'} DEEP IDENTITY
        </button>
        {showAdvanced && (
          <div style={{ padding: '12px 0', display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <label style={labelStyle}>OCCUPATION</label>
              <input className="af-input" value={occupation} onChange={(e) => setOccupation(e.target.value)} placeholder="e.g. Blacksmith, Scholar" style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>BACKSTORY (500 chars)</label>
              <textarea className="af-input" value={backstory} onChange={(e) => setBackstory(e.target.value)} maxLength={500} rows={3} style={{ ...inputStyle, resize: 'vertical' }} />
            </div>
            <div>
              <label style={labelStyle}>GOAL (200 chars)</label>
              <input className="af-input" value={goal} onChange={(e) => setGoal(e.target.value)} maxLength={200} style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>STARTING GOLD (0-10000)</label>
              <input
                className="af-input"
                type="number"
                value={startingGold}
                onChange={(e) => setStartingGold(Math.max(0, Math.min(10000, Number(e.target.value) || 0)))}
                min={0}
                max={10000}
                style={inputStyle}
              />
            </div>
            <div>
              <label style={labelStyle}>FEARS (300 chars, comma-separated)</label>
              <input className="af-input" value={fears} onChange={(e) => setFears(e.target.value)} maxLength={300} style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>DESIRES (300 chars, comma-separated)</label>
              <input className="af-input" value={desires} onChange={(e) => setDesires(e.target.value)} maxLength={300} style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>CORE VALUES (300 chars, comma-separated)</label>
              <input className="af-input" value={coreValues} onChange={(e) => setCoreValues(e.target.value)} maxLength={300} style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>CONTRADICTIONS (200 chars)</label>
              <input className="af-input" value={contradictions} onChange={(e) => setContradictions(e.target.value)} maxLength={200} style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>SPEECH PATTERN (200 chars)</label>
              <input className="af-input" value={speechPattern} onChange={(e) => setSpeechPattern(e.target.value)} maxLength={200} style={inputStyle} />
            </div>
          </div>
        )}
      </div>

      {/* Divider */}
      <div style={{ height: 1, background: BORDER_DIM, margin: '16px 0' }} />

      {/* SOUL textarea */}
      <div style={{ marginBottom: 16 }}>
        <label style={labelStyle}>SOUL *</label>
        <textarea
          className="af-input"
          value={soul}
          onChange={(e) => setSoul(e.target.value)}
          maxLength={2000}
          rows={6}
          placeholder={SOUL_PLACEHOLDER}
          style={{ ...inputStyle, resize: 'vertical' }}
        />
        <div style={{ fontFamily: FONTS.pixel, fontSize: 6, color: LABEL_COLOR, textAlign: 'right', marginTop: 4 }}>
          {soul.length}/2000
        </div>
      </div>

      {/* CREATE AGENT button */}
      <button
        className="af-btn"
        onClick={handleSubmit}
        disabled={addingAgent || !name.trim() || !soul.trim()}
        style={{
          width: '100%',
          padding: '12px',
          fontFamily: FONTS.pixel,
          fontSize: 9,
          color: addingAgent ? LABEL_COLOR : BG,
          background: addingAgent ? BORDER_DIM : ACCENT,
          border: 'none',
          borderRadius: 4,
          cursor: addingAgent ? 'not-allowed' : 'pointer',
          letterSpacing: 2,
          transition: 'all 0.2s',
        }}
      >
        {addingAgent ? 'CREATING...' : 'CREATE AGENT'}
      </button>
    </div>
  );
};
