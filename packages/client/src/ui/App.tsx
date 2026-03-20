import React, { useEffect, useRef, useState } from 'react';
import Phaser from 'phaser';
import { createGameConfig } from '../game/config';
import { Sidebar } from './components/Sidebar';
import { TimeDisplay } from './components/TimeDisplay';
import { SetupPage } from './components/SetupPage';
import { connectSocket } from '../network/socket';

export const App: React.FC = () => {
  const [entered, setEntered] = useState(false);
  const gameContainerRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<Phaser.Game | null>(null);

  const handleEnter = () => {
    connectSocket();
    setEntered(true);
  };

  useEffect(() => {
    if (entered && gameContainerRef.current && !gameRef.current) {
      const config = createGameConfig('game-container');
      gameRef.current = new Phaser.Game(config);
    }

    return () => {
      gameRef.current?.destroy(true);
      gameRef.current = null;
    };
  }, [entered]);

  if (!entered) {
    return <SetupPage onEnter={handleEnter} />;
  }

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}>
      {/* Map fills entire screen */}
      <div
        id="game-container"
        ref={gameContainerRef}
        style={{ width: '100%', height: '100%' }}
      />
      <div style={{ position: 'absolute', top: 0, left: 0, zIndex: 10 }}>
        <TimeDisplay />
      </div>
      {/* Sidebar overlays on right */}
      <div style={{ position: 'absolute', top: 0, right: 0, bottom: 0, width: 420, zIndex: 10 }}>
        <Sidebar />
      </div>
    </div>
  );
};
