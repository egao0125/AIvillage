import React, { useEffect, useState, useRef, useCallback } from 'react';
import { devPause, devResume, devStep, devResetVitals, devFreshStart, devRequestStatus, onDevStatus } from '../../network/socket';

export const DevPanel: React.FC = () => {
  const [paused, setPaused] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 8 });
  const dragging = useRef(false);
  const offset = useRef({ x: 0, y: 0 });
  const panelRef = useRef<HTMLDivElement>(null);

  // Center horizontally on mount
  useEffect(() => {
    if (panelRef.current) {
      const w = panelRef.current.offsetWidth;
      setPos({ x: Math.round((window.innerWidth - w) / 2), y: 8 });
    }
  }, []);

  useEffect(() => {
    devRequestStatus();
    const unsub = onDevStatus((data) => setPaused(data.paused));
    return unsub;
  }, []);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    dragging.current = true;
    offset.current = { x: e.clientX - pos.x, y: e.clientY - pos.y };
  }, [pos]);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      setPos({ x: e.clientX - offset.current.x, y: e.clientY - offset.current.y });
    };
    const onMouseUp = () => { dragging.current = false; };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  const btnStyle: React.CSSProperties = {
    padding: '6px 12px',
    fontSize: 12,
    fontFamily: 'monospace',
    border: '1px solid #555',
    borderRadius: 4,
    cursor: 'pointer',
    color: '#eee',
    background: '#333',
  };

  return (
    <div
      ref={panelRef}
      onMouseDown={onMouseDown}
      style={{
        position: 'fixed',
        top: pos.y,
        left: pos.x,
        zIndex: 9999,
        display: 'flex',
        gap: 6,
        alignItems: 'center',
        background: 'rgba(0,0,0,0.85)',
        padding: '6px 12px',
        borderRadius: 6,
        border: '1px solid #444',
        cursor: 'grab',
        userSelect: 'none',
        pointerEvents: 'auto',
      }}
    >
      <span style={{ color: '#888', fontSize: 11, fontFamily: 'monospace', marginRight: 4 }}>DEV</span>
      {paused ? (
        <>
          <button style={{ ...btnStyle, background: '#2a5a2a' }} onClick={devResume}>Play</button>
          <button style={btnStyle} onClick={devStep}>Step</button>
        </>
      ) : (
        <button style={{ ...btnStyle, background: '#5a2a2a' }} onClick={devPause}>Pause</button>
      )}
      <button style={btnStyle} onClick={devResetVitals}>Reset Vitals</button>
      <button style={{ ...btnStyle, background: '#5a3a2a' }} onClick={() => {
        if (confirm('Fresh Start: Wipe all memories and world state? Agents keep their identity but lose all experiences.')) {
          devFreshStart();
        }
      }}>Fresh Start</button>
      <span style={{ color: paused ? '#f88' : '#8f8', fontSize: 11, fontFamily: 'monospace' }}>
        {paused ? 'PAUSED' : 'RUNNING'}
      </span>
    </div>
  );
};
