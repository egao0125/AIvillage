import React, { useState, useEffect, useRef } from 'react';
import Phaser from 'phaser';
import { createGameConfig } from '../../game/config';
import { useActiveMode } from '../../core/hooks';
import { connectSocket } from '../../network/socket';
import { clearToken } from '../../utils/auth';
import { TopNav } from './TopNav';
import { WatchView } from './WatchView';
import { SetupPage } from '../components/SetupPage';
import { MapSelectPage } from '../components/MapSelectPage';
import { AgentCreator } from '../components/AgentCreator';
import { AnalyzeView } from './AnalyzeView';

export const AppShell: React.FC = () => {
  const [selectedMap, setSelectedMap] = useState<string | null>(() => sessionStorage.getItem('ai-village-map'));
  const [entered, setEntered] = useState(() => sessionStorage.getItem('ai-village-entered') === 'true');
  const [agentCreatorOpen, setAgentCreatorOpen] = useState(false);
  const activeMode = useActiveMode();
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
    sessionStorage.setItem('ai-village-map', mapId);
    setSelectedMap(mapId);
  };

  const handleEnter = () => {
    connectSocket();
    sessionStorage.setItem('ai-village-entered', 'true');
    setEntered(true);
  };

  const handleBackToMaps = () => {
    sessionStorage.removeItem('ai-village-entered');
    sessionStorage.removeItem('ai-village-map');
    setEntered(false);
    setSelectedMap(null);
  };

  const handleChangeMap = () => {
    sessionStorage.removeItem('ai-village-entered');
    sessionStorage.removeItem('ai-village-map');
    setEntered(false);
    setSelectedMap(null);
  };

  const handleLogout = () => {
    clearToken();
    sessionStorage.removeItem('ai-village-entered');
    sessionStorage.removeItem('ai-village-map');
    setEntered(false);
    setSelectedMap(null);
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
      const config = createGameConfig('game-container', selectedMap || undefined);
      gameRef.current = new Phaser.Game(config);
    }

    return () => {
      gameRef.current?.destroy(true);
      gameRef.current = null;
    };
  }, [entered]);

  // Map selection screen
  if (!selectedMap) {
    return <MapSelectPage onSelect={handleMapSelect} />;
  }

  // Setup/agent creation screen
  if (!entered) {
    return <SetupPage onEnter={handleEnter} onBack={() => { sessionStorage.removeItem('ai-village-map'); setSelectedMap(null); }} />;
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
          visibility: 'visible',
        }}
      />
      {/* Vignette overlay — below all UI, above canvas */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          background: 'radial-gradient(ellipse at center, transparent 60%, rgba(148, 136, 110, 0.4) 100%)',
          zIndex: 2,
        }}
      />
      {activeMode === 'watch' && <WatchView onAddAgent={() => setAgentCreatorOpen(true)} />}
      {activeMode === 'analyze' && <AnalyzeView />}
      <TopNav
        onChangeMap={handleChangeMap}
        onLogout={handleLogout}
      />
      <AgentCreator open={agentCreatorOpen} onClose={() => setAgentCreatorOpen(false)} />
    </div>
  );
};
