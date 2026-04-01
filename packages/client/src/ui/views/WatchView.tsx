import React, { useState } from 'react';
import { COLORS, FONTS } from '../styles';
import { SetupPage } from '../components/SetupPage';
import { SpectatorChat } from '../components/SpectatorChat';
import { NarrativeBar } from '../components/NarrativeBar';
import { AgentRoster } from '../components/AgentRoster';
import { VillageInfo } from '../components/VillageInfo';
import { CharacterPage } from '../components/CharacterPage';
import { RecapOverlay } from '../components/RecapOverlay';
import { DevPanel } from '../components/DevPanel';
import { SocialView } from '../social/SocialView';
import { EventFeed } from '../feed/EventFeed';
import { useCharacterPageAgentId, useActiveRecap, useSocialViewOpen } from '../../core/hooks';

const EVENT_FEED_WIDTH = 380;
const DEV_TOOLS_ENABLED = true;

export const WatchView: React.FC = () => {
  const [eventFeedOpen, setEventFeedOpen] = useState(true);
  const [showSetup, setShowSetup] = useState(false);

  const characterPageAgentId = useCharacterPageAgentId();
  const activeRecap = useActiveRecap();
  const socialViewOpen = useSocialViewOpen();

  const feedWidth = eventFeedOpen ? EVENT_FEED_WIDTH : 0;

  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
      {/* Overlay buttons on canvas — below TopNav bar */}
      <AgentRoster />
      <VillageInfo />

      {/* Event Feed panel — right side */}
      <div style={{
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        width: feedWidth,
        zIndex: 10,
        transition: 'width 0.25s ease',
        overflow: 'hidden',
        background: COLORS.bg,
        borderLeft: eventFeedOpen ? `1px solid ${COLORS.border}` : 'none',
      }}>
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
        <div style={{ height: 'calc(100% - 42px)', overflowY: 'auto' }}>
          <EventFeed />
        </div>
      </div>

      {/* Event Feed toggle when closed */}
      {!eventFeedOpen && (
        <button
          onClick={() => setEventFeedOpen(true)}
          style={{
            position: 'absolute',
            right: 0,
            top: 70,
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
      <NarrativeBar sidebarWidth={feedWidth} />

      {/* Spectator chat — floating bottom-left */}
      <SpectatorChat />

      {/* Add agent button — next to overlay pills */}
      <button
        onClick={() => setShowSetup(true)}
        style={{
          position: 'absolute',
          top: 48,
          left: 260,
          padding: '5px 12px',
          background: COLORS.bg,
          border: `1px solid ${COLORS.border}`,
          borderRadius: 4,
          cursor: 'pointer',
          color: COLORS.textDim,
          fontFamily: FONTS.pixel,
          fontSize: '8px',
          letterSpacing: 0.5,
          zIndex: 20,
        }}
      >
        + AGENT
      </button>

      {/* Overlays — kept as-is */}
      {characterPageAgentId && <CharacterPage />}
      {activeRecap && <RecapOverlay />}
      {socialViewOpen && <SocialView />}
      {showSetup && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 100, overflowY: 'auto' }}>
          <SetupPage onEnter={() => setShowSetup(false)} />
        </div>
      )}
      {DEV_TOOLS_ENABLED && <DevPanel />}
    </div>
  );
};
