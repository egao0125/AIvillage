import React, { useState } from 'react';
import { FONTS } from '../styles';
import { useTheme } from '../ThemeContext';
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
  const { colors } = useTheme();
  const [eventFeedOpen, setEventFeedOpen] = useState(true);
  const activeRecap = useActiveRecap();
  const inspectTarget = useInspectTarget();

  const sidebarWidth = (eventFeedOpen ? PANEL_WIDTH : 0) + (inspectTarget ? PANEL_WIDTH : 0);

  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
      {/* Overlay buttons on canvas — below TopNav bar */}
      <OverlayPanel onAddAgent={onAddAgent} />

      {/* Primary: Event Feed panel */}
      {eventFeedOpen && (
        <SidePanel position="primary" width={PANEL_WIDTH}>
          <div style={{
            padding: '10px 14px',
            borderBottom: `1px solid ${colors.border}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}>
            <span style={{ fontFamily: FONTS.pixel, fontSize: '9px', color: colors.accent, letterSpacing: 1 }}>
              EVENT FEED
            </span>
            <button
              onClick={() => setEventFeedOpen(false)}
              style={{
                background: 'none',
                border: 'none',
                color: colors.textDim,
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

      {/* Stacked: Detail panel (ContextPanel) — right-aligned to feed, or to screen edge if feed closed */}
      {inspectTarget && (
        <SidePanel
          position="stacked"
          width={PANEL_WIDTH}
          rightOffset={eventFeedOpen ? PANEL_WIDTH : 0}
          onClose={() => gameStore.closeDetail()}
        >
          <ContextPanel />
        </SidePanel>
      )}

      {/* Event Feed toggle when closed */}
      {!eventFeedOpen && (
        <button
          onClick={() => setEventFeedOpen(true)}
          style={{
            position: 'absolute',
            right: 0,
            top: 50,
            pointerEvents: 'auto',
            width: 24,
            height: 48,
            background: colors.bg,
            border: `1px solid ${colors.border}`,
            borderRight: 'none',
            borderRadius: '6px 0 0 6px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: colors.accent,
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
