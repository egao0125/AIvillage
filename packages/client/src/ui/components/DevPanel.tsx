import React, { useEffect, useState } from 'react';
import { devPause, devResume, devStep, devResetVitals, devFreshStart, devRequestStatus, onDevStatus } from '../../network/socket';

export const DevPanel: React.FC = () => {
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    devRequestStatus();
    const unsub = onDevStatus((data) => setPaused(data.paused));
    return unsub;
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
    <div style={{
      position: 'fixed',
      top: 8,
      left: '50%',
      transform: 'translateX(-50%)',
      zIndex: 9999,
      display: 'flex',
      gap: 6,
      alignItems: 'center',
      background: 'rgba(0,0,0,0.85)',
      padding: '6px 12px',
      borderRadius: 6,
      border: '1px solid #444',
    }}>
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
