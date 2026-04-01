import React, { useEffect, useRef, useState } from 'react';
import Phaser from 'phaser';
import { createGameConfig } from '../game/config';
import { Sidebar, SIDEBAR_WIDTH } from './components/Sidebar';
import { COLORS, FONTS } from './styles';
import { TimeDisplay } from './components/TimeDisplay';
import { SetupPage } from './components/SetupPage';
import { MapSelectPage } from './components/MapSelectPage';
import { SpectatorChat } from './components/SpectatorChat';
import { FeedButton } from './components/FeedButton';
import { NarrativeBar } from './components/NarrativeBar';
import { CharacterPage } from './components/CharacterPage';
import { RecapOverlay } from './components/RecapOverlay';
import { DevPanel } from './components/DevPanel';
import { SocialView } from './social/SocialView';
import { connectSocket } from '../network/socket';
import { useCharacterPageAgentId, useActiveRecap, useSocialViewOpen } from '../core/hooks';

// Toggle dev tools — controlled by VITE_DEV_TOOLS_ENABLED env var (default: false)
const DEV_TOOLS_ENABLED = import.meta.env.VITE_DEV_TOOLS_ENABLED === 'true';

export const App: React.FC = () => {
  const [selectedMap, setSelectedMap] = useState<string | null>(null);
  const [entered, setEntered] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
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
  const socialViewOpen = useSocialViewOpen();

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
      {/* Social dynamics graph */}
      {socialViewOpen && <SocialView />}
      {/* Spectator chat — floating bottom-left */}
      <SpectatorChat onOpenChange={setSpectatorChatOpen} />
      {/* Feed — floating button next to chat */}
      <FeedButton chatOpen={spectatorChatOpen} />
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
      {/* Dev tools — toggle via DEV_TOOLS_ENABLED */}
      {DEV_TOOLS_ENABLED && <DevPanel />}
    </div>
  );
};
