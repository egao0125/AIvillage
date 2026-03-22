import React, { useEffect, useRef, useState } from 'react';
import Phaser from 'phaser';
import { createGameConfig } from '../game/config';
import { Sidebar, SIDEBAR_WIDTH } from './components/Sidebar';
import { COLORS, FONTS } from './styles';
import { TimeDisplay } from './components/TimeDisplay';
import { SetupPage } from './components/SetupPage';
import { SpectatorChat } from './components/SpectatorChat';
import { FeedButton } from './components/FeedButton';
import { NarrativeBar } from './components/NarrativeBar';
import { CharacterPage } from './components/CharacterPage';
import { RecapOverlay } from './components/RecapOverlay';
import { DevPanel } from './components/DevPanel';
import { connectSocket } from '../network/socket';
import { useCharacterPageAgentId, useActiveRecap } from '../core/hooks';

// Toggle dev tools — set to false to remove entirely
const DEV_TOOLS_ENABLED = true;

export const App: React.FC = () => {
  const [entered, setEntered] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
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
      {/* Sidebar toggle button — outside sidebar so it's always visible */}
      <button
        onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
        style={{
          position: 'absolute',
          right: sidebarCollapsed ? 0 : SIDEBAR_WIDTH,
          top: 14,
          width: 24,
          height: 48,
          background: COLORS.bg,
          border: `1px solid ${COLORS.border}`,
          borderRight: sidebarCollapsed ? `1px solid ${COLORS.border}` : 'none',
          borderRadius: '6px 0 0 6px',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: COLORS.textDim,
          fontFamily: FONTS.pixel,
          fontSize: '12px',
          zIndex: 11,
          padding: 0,
          transition: 'right 0.25s ease',
        }}
      >
        {sidebarCollapsed ? '◀' : '▶'}
      </button>
      {/* Sidebar overlays on right */}
      <div style={{
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        width: sidebarCollapsed ? 0 : SIDEBAR_WIDTH,
        zIndex: 10,
        transition: 'width 0.25s ease',
        overflow: 'hidden',
      }}>
        <Sidebar collapsed={sidebarCollapsed} onToggle={() => setSidebarCollapsed(!sidebarCollapsed)} />
      </div>
      {/* Narrative bar — bottom overlay */}
      <NarrativeBar sidebarWidth={sidebarCollapsed ? 0 : SIDEBAR_WIDTH} />
      {/* Character page — slides in from right */}
      {characterPageAgentId && <CharacterPage />}
      {/* Recap overlay — full screen cinematic */}
      {activeRecap && <RecapOverlay />}
      {/* Spectator chat — floating bottom-left */}
      <SpectatorChat />
      {/* Feed — floating button next to chat */}
      <FeedButton />
      {/* Dev tools — toggle via DEV_TOOLS_ENABLED */}
      {DEV_TOOLS_ENABLED && <DevPanel />}
    </div>
  );
};
