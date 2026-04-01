import React, { useState } from 'react';
import { COLORS, FONTS } from '../styles';
import { SpectatorChat } from '../components/SpectatorChat';
import { NarrativeBar } from '../components/NarrativeBar';
import { OverlayPanel } from '../components/OverlayPanel';
import { RecapOverlay } from '../components/RecapOverlay';
import { DevPanel } from '../components/DevPanel';
import { EventFeed } from '../feed/EventFeed';
import { SidePanel } from '../shared/SidePanel';
import { ContextPanel } from '../inspect/ContextPanel';
import { useActiveRecap, useInspectTarget } from '../../core/hooks';
import { gameStore } from '../../core/GameStore';

const DEV_TOOLS_ENABLED = true;
const PANEL_WIDTH = 420;

interface WatchViewProps {
  onAddAgent?: () => void;
}

export const WatchView: React.FC<WatchViewProps> = ({ onAddAgent }) => {
  const [eventFeedOpen, setEventFeedOpen] = useState(true);
  const activeRecap = useActiveRecap();
  const inspectTarget = useInspectTarget();

  const sidebarWidth = inspectTarget ? PANEL_WIDTH : eventFeedOpen ? PANEL_WIDTH : 0;

  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
      {/* Overlay buttons on canvas — below TopNav bar */}
      <OverlayPanel onAddAgent={onAddAgent} />

      {/* Primary: Event Feed panel */}
      {eventFeedOpen && (
        <SidePanel position="primary" width={PANEL_WIDTH}>
          <div style={{
            padding: '10px 14px',
            borderBottom: `1px solid ${COLORS.border}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}>
            <span style={{ fontFamily: FONTS.pixel, fontSize: '9px', color: COLORS.accent, letterSpacing: 1 }}>
              EVENT FEED
            </span>
            <button
              onClick={() => setEventFeedOpen(false)}
              style={{
                background: 'none',
                border: 'none',
                color: COLORS.textDim,
                cursor: 'pointer',
                fontSize: '14px',
                fontFamily: FONTS.body,
              }}
            >
              ✕
            </button>
          </div>
          <EventFeed />
        </SidePanel>
      )}

      {/* Stacked: Detail panel (ContextPanel) */}
      {inspectTarget && (
        <SidePanel position="stacked" width={PANEL_WIDTH} onClose={() => gameStore.closeDetail()}>
          <ContextPanel />
        </SidePanel>
      )}

      {/* Event Feed toggle when closed */}
      {!eventFeedOpen && !inspectTarget && (
        <button
          onClick={() => setEventFeedOpen(true)}
          style={{
            position: 'absolute',
            right: 0,
            top: 50,
            pointerEvents: 'auto',
            width: 24,
            height: 48,
            background: COLORS.bg,
            border: `1px solid ${COLORS.border}`,
            borderRight: 'none',
            borderRadius: '6px 0 0 6px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: COLORS.accent,
            fontFamily: FONTS.pixel,
            fontSize: '12px',
            zIndex: 11,
            padding: 0,
          }}
        >
          ◀
        </button>
      )}

      {/* Narrative bar — bottom overlay, avoids feed panel */}
      <NarrativeBar sidebarWidth={sidebarWidth} />

      {/* Spectator chat — floating bottom-left */}
      <SpectatorChat />

      {/* Overlays — kept as-is */}
      {activeRecap && <RecapOverlay />}
      {DEV_TOOLS_ENABLED && <DevPanel />}
    </div>
  );
};
