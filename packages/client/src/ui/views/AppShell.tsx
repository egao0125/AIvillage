import React, { useState, useEffect, useRef } from 'react';
import Phaser from 'phaser';
import { createGameConfig } from '../../game/config';
import { useActiveMode } from '../../core/hooks';
import { connectSocket } from '../../network/socket';
import { TopNav } from './TopNav';
import { WatchView } from './WatchView';
import { SetupPage } from '../components/SetupPage';
import { COLORS, FONTS } from '../styles';

const Placeholder: React.FC<{ mode: string }> = ({ mode }) => (
  <div
    style={{
      width: '100%',
      height: '100%',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: COLORS.bg,
      color: COLORS.textDim,
      fontFamily: FONTS.pixel,
      fontSize: '10px',
      letterSpacing: 1,
    }}
  >
    {mode.toUpperCase()} MODE — COMING SOON
  </div>
);

export const AppShell: React.FC = () => {
  const [entered, setEntered] = useState(() => sessionStorage.getItem('ai-village-entered') === 'true');
  const activeMode = useActiveMode();
  const gameContainerRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<Phaser.Game | null>(null);

  const handleEnter = () => {
    connectSocket();
    sessionStorage.setItem('ai-village-entered', 'true');
    setEntered(true);
  };

  // Reconnect socket on refresh if already entered
  useEffect(() => {
    if (entered) {
      connectSocket();
    }
  }, []);

  // Init Phaser once entered
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
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      {/* Phaser canvas — persists across all modes */}
      <div
        id="game-container"
        ref={gameContainerRef}
        style={{
          width: '100%',
          height: '100%',
          display: activeMode === 'watch' ? 'block' : 'none',
        }}
      />
      {activeMode === 'watch' && <WatchView />}
      {activeMode === 'inspect' && <Placeholder mode="inspect" />}
      {activeMode === 'analyze' && <Placeholder mode="analyze" />}
      <TopNav />
    </div>
  );
};
