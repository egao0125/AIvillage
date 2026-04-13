import React, { useCallback, useEffect, useState } from 'react';
import { useFocusedAgent, useSidebarWidth } from '../../core/hooks';
import { gameStore } from '../../core/GameStore';
import { eventBus } from '../../core/EventBus';

const arrowBase: React.CSSProperties = {
  width: 36,
  height: 36,
  borderRadius: '50%',
  background: 'transparent',
  border: 'none',
  color: '#8888a8',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 14,
  transition: 'all 0.15s',
};

export const AgentNavArrows: React.FC = () => {
  const { agent, index, total } = useFocusedAgent();
  const sidebarWidth = useSidebarWidth();
  const [hoveredBtn, setHoveredBtn] = useState<'left' | 'right' | null>(null);

  const goNext = useCallback(() => {
    gameStore.focusNextAgent();
    const s = gameStore.getState();
    if (s.selectedAgentId) eventBus.emit('agent:focus', s.selectedAgentId);
  }, []);

  const goPrev = useCallback(() => {
    gameStore.focusPrevAgent();
    const s = gameStore.getState();
    if (s.selectedAgentId) eventBus.emit('agent:focus', s.selectedAgentId);
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA' || el?.isContentEditable) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); goPrev(); }
      if (e.key === 'ArrowRight') { e.preventDefault(); goNext(); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [goNext, goPrev]);

  if (!agent || total === 0) return null;

  const actionText = agent.currentAction || '';
  const truncated = actionText.length > 30 ? actionText.substring(0, 28) + '\u2026' : actionText;

  const hoverStyle = (btn: 'left' | 'right'): React.CSSProperties => ({
    ...arrowBase,
    ...(hoveredBtn === btn && { background: 'rgba(100, 255, 218, 0.15)', color: '#64ffda' }),
  });

  return (
    <div style={{
      position: 'absolute',
      bottom: 80,
      left: `calc((100% - ${sidebarWidth}px) / 2)`,
      transform: 'translateX(-50%)',
      zIndex: 50,
      pointerEvents: 'auto',
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '6px 12px',
      background: 'rgba(22, 22, 37, 0.85)',
      backdropFilter: 'blur(12px)',
      border: '1px solid rgba(100, 255, 218, 0.08)',
      borderRadius: 12,
    }}>
      <button
        onClick={goPrev}
        onMouseEnter={() => setHoveredBtn('left')}
        onMouseLeave={() => setHoveredBtn(null)}
        style={hoverStyle('left')}
      >
        ◀
      </button>

      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 120 }}>
        <span style={{
          fontSize: 12,
          fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, sans-serif',
          color: '#e8e8f0',
          fontWeight: 600,
          whiteSpace: 'nowrap',
        }}>
          {agent.config.name}
          <span style={{ fontWeight: 400, color: '#555570', fontSize: 10, marginLeft: 6 }}>
            {index + 1}/{total}
          </span>
        </span>
        {truncated && (
          <span style={{
            fontSize: 11,
            fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, sans-serif',
            color: '#555570',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            maxWidth: 200,
          }}>
            {truncated}
          </span>
        )}
      </div>

      <button
        onClick={goNext}
        onMouseEnter={() => setHoveredBtn('right')}
        onMouseLeave={() => setHoveredBtn(null)}
        style={hoverStyle('right')}
      >
        ▶
      </button>
    </div>
  );
};
