import React, { useEffect, useRef, useState } from 'react';
import Phaser from 'phaser';
import { createGameConfig } from '../game/config';
import { COLORS, FONTS } from './styles';
import { TimeDisplay } from './components/TimeDisplay';
import { SetupPage } from './components/SetupPage';
import { MapSelectPage } from './components/MapSelectPage';
import { SpectatorChat } from './components/SpectatorChat';
import { NarrativeBar } from './components/NarrativeBar';
import { RecapOverlay } from './components/RecapOverlay';
import { WerewolfGameOver } from './components/WerewolfGameOver';
import { WerewolfControls } from './components/WerewolfControls';
import { DevPanel } from './components/DevPanel';
import { connectSocket, werewolfPlayAgain } from '../network/socket';
import { useActiveRecap, useWerewolfGameOver, useIsAdmin } from '../core/hooks';
import { gameStore } from '../core/GameStore';

export const App: React.FC = () => {
  const [selectedMap, setSelectedMap] = useState<string | null>(null);
  const [entered, setEntered] = useState(false);
  const [spectatorChatOpen, setSpectatorChatOpen] = useState(false);
  const gameContainerRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<Phaser.Game | null>(null);

  const handleMapSelect = async (mapId: string) => {
    try {
      await fetch('/api/config/map', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mapId }),
      });
    } catch (e) {
      console.warn('[MapSelect] Failed to set map config:', e);
    }
    setSelectedMap(mapId);
  };

  const handleEnter = () => {
    connectSocket();
    setEntered(true);
  };

  useEffect(() => {
    if (entered && gameContainerRef.current && !gameRef.current) {
      const config = createGameConfig('game-container', selectedMap || undefined);
      gameRef.current = new Phaser.Game(config);
    }

    return () => {
      gameRef.current?.destroy(true);
      gameRef.current = null;
    };
  }, [entered]);

  const activeRecap = useActiveRecap();
  const werewolfGameOver = useWerewolfGameOver();
  const isAdmin = useIsAdmin();

  if (!selectedMap) {
    return <MapSelectPage onSelect={handleMapSelect} />;
  }

  if (!entered) {
    return <SetupPage onEnter={handleEnter} onBack={() => setSelectedMap(null)} />;
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
      {/* Werewolf controls — top-right overlay */}
      {selectedMap === 'werewolf' && <WerewolfControls />}
      {/* Narrative bar — bottom overlay */}
      <NarrativeBar sidebarWidth={0} />
      {/* Recap overlay — full screen cinematic */}
      {activeRecap && <RecapOverlay />}
      {/* Werewolf game over overlay */}
      {werewolfGameOver && (
        <WerewolfGameOver
          payload={werewolfGameOver}
          onPlayAgain={() => {
            gameStore.setWerewolfGameOver(null);
            werewolfPlayAgain();
          }}
          onBackToMenu={() => {
            gameStore.setWerewolfGameOver(null);
            setSelectedMap(null);
            setEntered(false);
          }}
        />
      )}
      {/* Spectator chat — floating bottom-left */}
      <SpectatorChat onOpenChange={setSpectatorChatOpen} />
      {/* Back to setup button */}
      <button
        onClick={() => setEntered(false)}
        style={{
          position: 'absolute',
          top: 14,
          left: 200,
          padding: '6px 14px',
          background: COLORS.bg,
          border: `1px solid ${COLORS.border}`,
          borderRadius: 4,
          cursor: 'pointer',
          color: COLORS.textDim,
          fontFamily: FONTS.pixel,
          fontSize: '8px',
          letterSpacing: 1,
          zIndex: 10,
        }}
      >
        + ADD AGENT
      </button>
      {/* Dev tools — visible only to admin users */}
      {isAdmin && <DevPanel />}
    </div>
  );
};
