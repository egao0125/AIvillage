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
    <div style={{ display: 'flex', width: '100vw', height: '100vh' }}>
      <div
        id="game-container"
        ref={gameContainerRef}
        style={{ flex: 1, position: 'relative' }}
      >
        <TimeDisplay />
      </div>
      <Sidebar />
    </div>
  );
};
