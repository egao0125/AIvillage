import React, { useEffect, useRef, useState } from 'react';
import Phaser from 'phaser';
import { createGameConfig } from '../game/config';
import { Sidebar } from './components/Sidebar';
import { TimeDisplay } from './components/TimeDisplay';
import { SetupPage } from './components/SetupPage';
import { SpectatorChat } from './components/SpectatorChat';
import { NarrativeBar } from './components/NarrativeBar';
import { CharacterPage } from './components/CharacterPage';
import { RecapOverlay } from './components/RecapOverlay';
import { connectSocket } from '../network/socket';
import { useCharacterPageAgentId, useActiveRecap } from '../core/hooks';

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

  const characterPageAgentId = useCharacterPageAgentId();
  const activeRecap = useActiveRecap();

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
      {/* Narrative bar — bottom overlay */}
      <NarrativeBar />
      {/* Character page — slides in from right */}
      {characterPageAgentId && <CharacterPage />}
      {/* Recap overlay — full screen cinematic */}
      {activeRecap && <RecapOverlay />}
      {/* Spectator chat — floating bottom-left */}
      <SpectatorChat />
    </div>
  );
};
