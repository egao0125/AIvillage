import React, { useEffect, useState } from 'react';
import { FONTS } from '../styles';
import { useTheme } from '../ThemeContext';

const TRUNCATE = 120;

export const CharacterArc: React.FC<{ agentId: string }> = ({ agentId }) => {
  const { colors } = useTheme();
  const [summary, setSummary] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    setSummary(null);
    setExpanded(false);

    fetch(`/api/agents/${agentId}/arc-summary`)
      .then((res) => {
        if (!res.ok) throw new Error('fetch failed');
        return res.json();
      })
      .then((data: { summary?: string }) => {
        if (!cancelled) {
          setSummary(data.summary ?? null);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError(true);
          setLoading(false);
        }
      });

    return () => { cancelled = true; };
  }, [agentId]);

  if (error) return null;

  const text = summary || 'Their story is just beginning...';
  const isLong = text.length > TRUNCATE;
  const displayText = isLong && !expanded ? text.slice(0, TRUNCATE) + '...' : text;

  return (
    <div style={{ padding: '8px 0' }}>
      <div style={{ fontFamily: FONTS.pixel, fontSize: 8, color: colors.gold, letterSpacing: 2, marginBottom: 8 }}>
        CHARACTER ARC
      </div>

      {loading ? (
        <div style={{ fontFamily: FONTS.body, fontSize: 13, color: colors.textDim, animation: 'pulse 1.5s ease-in-out infinite' }}>
          ...
          <style>{`@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }`}</style>
        </div>
      ) : (
        <div
          onClick={() => { if (isLong) setExpanded(prev => !prev); }}
          style={{
            fontFamily: FONTS.body,
            fontSize: 13,
            color: colors.textDim,
            fontStyle: 'italic',
            lineHeight: 1.7,
            cursor: isLong ? 'pointer' : undefined,
          }}
        >
          {displayText}
        </div>
      )}
    </div>
  );
};
