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
import { useActiveRecap, useInspectTarget, useIsAdmin, useIsMobile } from '../../core/hooks';
import { gameStore } from '../../core/GameStore';
const PANEL_WIDTH = 420;
const MOBILE_PANEL_WIDTH = '100vw';

interface WatchViewProps {
  onAddAgent?: () => void;
}

export const WatchView: React.FC<WatchViewProps> = ({ onAddAgent }) => {
  const [eventFeedOpen, setEventFeedOpen] = useState(true);
  const activeRecap = useActiveRecap();
  const inspectTarget = useInspectTarget();
  const isAdmin = useIsAdmin();
  const isMobile = useIsMobile();

  // On mobile, default to feed closed so the game canvas is visible
  const [mobileInitialized, setMobileInitialized] = useState(false);
  if (isMobile && !mobileInitialized) {
    setEventFeedOpen(false);
    setMobileInitialized(true);
  }

  const panelWidth = isMobile ? window.innerWidth : PANEL_WIDTH;
  const sidebarWidth = inspectTarget ? panelWidth : eventFeedOpen ? panelWidth : 0;

  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
      {/* Overlay buttons on canvas — below TopNav bar */}
      <OverlayPanel onAddAgent={onAddAgent} />

      {/* Primary: Event Feed panel */}
      {eventFeedOpen && (
        <SidePanel position="primary" width={panelWidth}>
          <div style={{
            padding: isMobile ? '12px 16px' : '10px 14px',
            borderBottom: `1px solid ${COLORS.border}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}>
            <span style={{ fontFamily: FONTS.pixel, fontSize: isMobile ? '11px' : '9px', color: COLORS.accent, letterSpacing: 1 }}>
              EVENT FEED
            </span>
            <button
              onClick={() => setEventFeedOpen(false)}
              style={{
                background: 'none',
                border: 'none',
                color: COLORS.textDim,
                cursor: 'pointer',
                fontSize: isMobile ? '20px' : '14px',
                fontFamily: FONTS.body,
                padding: isMobile ? '4px 8px' : 0,
              }}
            >
              ✕
            </button>
          </div>
          <EventFeed />
        </SidePanel>
      )}

      {/* Stacked: Detail panel (ContextPanel) — on mobile, replace primary */}
      {inspectTarget && (
        <SidePanel position={isMobile ? 'primary' : 'stacked'} width={panelWidth} onClose={() => gameStore.closeDetail()}>
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
            top: isMobile ? 48 : 50,
            pointerEvents: 'auto',
            width: isMobile ? 36 : 24,
            height: isMobile ? 56 : 48,
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
            fontSize: isMobile ? '16px' : '12px',
            zIndex: 11,
            padding: 0,
          }}
        >
          ◀
        </button>
      )}

      {/* Narrative bar — bottom overlay, avoids feed panel */}
      {!isMobile && <NarrativeBar sidebarWidth={sidebarWidth} />}

      {/* Spectator chat — hidden on mobile to avoid clutter */}
      {!isMobile && <SpectatorChat />}

      {/* Overlays — kept as-is */}
      {activeRecap && <RecapOverlay />}
      {isAdmin && <DevPanel />}
    </div>
  );
};
