import React, { useEffect, useRef, useState } from 'react';
import { FONTS } from '../styles';
import { useTheme } from '../ThemeContext';
import {
  useChatLog,
  useAgentsMap,
  useWerewolfPhase,
  useWerewolfRoles,
  useWerewolfGodMode,
  useWerewolfKills,
  useWerewolfVotes,
  useWerewolfNightActions,
  useWerewolfMeetingTranscripts,
  useAgents,
  useIsMobile,
} from '../../core/hooks';
import { gameStore } from '../../core/GameStore';
import { eventBus } from '../../core/EventBus';
import { werewolfStart, devResume } from '../../network/socket';
import type { ChatEntry } from '../../core/GameStore';

// ---------------------------------------------------------------------------
// Event system
// ---------------------------------------------------------------------------

type WerewolfEventType = 'conversation' | 'death' | 'save' | 'vote' | 'phase' | 'night' | 'role' | 'meeting';

interface WerewolfEvent {
  id: string;
  time: number;
  round: number;
  type: WerewolfEventType;
  icon: string;
  headline: string;
  detail?: string;
  conversationId?: string; // links to chat entries
  agentNames?: string[];
}

const EVENT_BADGES: Record<WerewolfEventType, { icon: string; label: string; color: string }> = {
  conversation: { icon: '\u{1F4AC}', label: 'CONVERSATION', color: '#60a5fa' },
  death:        { icon: '\u{1F480}', label: 'DEATH',         color: '#ef4444' },
  save:         { icon: '\u{1F6E1}', label: 'SAVED',         color: '#4ade80' },
  vote:         { icon: '\u{1F5F3}', label: 'VOTE',          color: '#f59e0b' },
  phase:        { icon: '\u{1F319}', label: 'PHASE',         color: '#a78bfa' },
  night:        { icon: '\u{1F43A}', label: 'NIGHT ACTION',  color: '#6366f1' },
  role:         { icon: '\u{1F3AD}', label: 'ROLE REVEAL',   color: '#ec4899' },
  meeting:      { icon: '\u{1F514}', label: 'MEETING',       color: '#f97316' },
};

const PHASE_COLORS: Record<string, string> = {
  night: '#6366f1',
  dawn: '#f59e0b',
  day: '#fbbf24',
  meeting: '#f97316',
  vote: '#ef4444',
  ended: '#6b7280',
};

const ROLE_COLORS: Record<string, string> = {
  werewolf: '#ef4444',
  sheriff: '#fbbf24',
  healer: '#4ade80',
  villager: '#9ca3af',
};

// ---------------------------------------------------------------------------
// Villager Roster
// ---------------------------------------------------------------------------

const VillagerRoster: React.FC<{
  agents: Array<{ id: string; config: { name: string; occupation?: string }; alive?: boolean }>;
  roles: Map<string, string>;
  godMode: boolean;
}> = ({ agents, roles, godMode }) => {
  const { colors } = useTheme();
  const [expanded, setExpanded] = useState(true);
  const aliveAgents = agents.filter(a => a.alive !== false);
  const deadAgents = agents.filter(a => a.alive === false);
  const sorted = [...aliveAgents, ...deadAgents];

  return (
    <div style={{ borderBottom: `1px solid ${colors.border}`, flexShrink: 0 }}>
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          cursor: 'pointer',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '6px 14px',
          background: colors.bgCard,
        }}
      >
        <span style={{ fontFamily: FONTS.pixel, fontSize: '7px', color: colors.textDim, letterSpacing: 0.5 }}>
          VILLAGERS ({aliveAgents.length} alive)
        </span>
        <span style={{ fontSize: 10, color: colors.textDim }}>{expanded ? '\u25BE' : '\u25B8'}</span>
      </div>
      {expanded && (
        <div style={{ padding: '2px 14px 8px' }}>
          {sorted.map(agent => {
            const isDead = agent.alive === false;
            const role = roles.get(agent.id);
            return (
              <div key={agent.id} style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '3px 0',
                opacity: isDead ? 0.4 : 1,
              }}>
                <span style={{
                  fontFamily: FONTS.body,
                  fontSize: 12,
                  color: isDead ? colors.textDim : colors.text,
                  textDecoration: isDead ? 'line-through' : 'none',
                }}>
                  {agent.config.name}
                  {role ? (
                    <span style={{ color: godMode ? (ROLE_COLORS[role] ?? colors.textDim) : colors.textDim }}>
                      {' '}({godMode ? role.charAt(0).toUpperCase() + role.slice(1) : 'Villager'})
                    </span>
                  ) : (
                    <span style={{ color: colors.textDim }}> (Unassigned)</span>
                  )}
                </span>
                {isDead && (
                  <span style={{ fontFamily: FONTS.pixel, fontSize: '5px', color: '#ef4444', letterSpacing: 0.3 }}>
                    DEAD
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Vote Tracker
// ---------------------------------------------------------------------------

const VoteTracker: React.FC<{
  votes: Array<{ round: number; votes: Record<string, string>; result: 'exiled' | 'no_exile'; exiledId: string | null }>;
  getName: (id: string) => string;
  currentRound: number;
  phase: string | null;
}> = ({ votes, getName, currentRound, phase }) => {
  const { colors } = useTheme();
  if (votes.length === 0) return null;

  // Show most recent vote first
  const sorted = [...votes].reverse();

  return (
    <div style={{ borderBottom: `1px solid ${colors.border}`, flexShrink: 0 }}>
      <div style={{
        padding: '6px 14px',
        background: colors.bgCard,
        fontFamily: FONTS.pixel,
        fontSize: '7px',
        color: colors.textDim,
        letterSpacing: 0.5,
      }}>
        VOTES ({votes.length})
      </div>
      <div style={{ padding: '4px 14px 8px', maxHeight: 180, overflowY: 'auto' }}>
        {sorted.map((vote, i) => {
          const isExiled = vote.result === 'exiled';
          const exiledName = vote.exiledId ? getName(vote.exiledId) : null;

          // Tally votes per target
          const tally: Record<string, string[]> = {};
          for (const [voterId, targetId] of Object.entries(vote.votes)) {
            if (!tally[targetId]) tally[targetId] = [];
            tally[targetId].push(getName(voterId));
          }
          // Sort by vote count descending
          const tallyEntries = Object.entries(tally).sort(([, a], [, b]) => b.length - a.length);

          return (
            <div key={i} style={{
              padding: '6px 0',
              borderBottom: i < sorted.length - 1 ? `1px solid ${colors.border}22` : undefined,
            }}>
              {/* Vote header */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <span style={{
                  fontFamily: FONTS.pixel, fontSize: '6px', letterSpacing: 0.3,
                  color: colors.textDim,
                }}>
                  R{vote.round}
                </span>
                <span style={{
                  fontFamily: FONTS.pixel, fontSize: '6px',
                  padding: '1px 6px', borderRadius: 3,
                  background: isExiled ? '#ef444433' : '#4ade8033',
                  color: isExiled ? '#ef4444' : '#4ade80',
                  letterSpacing: 0.3,
                }}>
                  {isExiled ? `${exiledName} EXILED` : 'NO EXILE'}
                </span>
              </div>
              {/* Tally per target */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                {tallyEntries.map(([targetId, voters]) => {
                  const isTarget = targetId === vote.exiledId;
                  return (
                    <div key={targetId} style={{
                      fontFamily: FONTS.body, fontSize: 10,
                      padding: '2px 6px', borderRadius: 3,
                      background: isTarget ? '#ef444418' : colors.bgCard,
                      border: `1px solid ${isTarget ? '#ef444433' : colors.border + '33'}`,
                      color: isTarget ? '#ef4444' : colors.text,
                    }}>
                      <span style={{ fontWeight: 600 }}>{getName(targetId)}</span>
                      <span style={{ color: colors.textDim }}> — {voters.length} vote{voters.length !== 1 ? 's' : ''} ({voters.join(', ')})</span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Meeting Log
// ---------------------------------------------------------------------------

const MeetingLog: React.FC<{
  transcripts: Array<{ round: number; transcript: Array<{ name: string; message: string }> }>;
}> = ({ transcripts }) => {
  const { colors } = useTheme();
  const [expanded, setExpanded] = useState(false);
  if (transcripts.length === 0) return null;

  // Show most recent meeting first
  const latest = transcripts[transcripts.length - 1];

  return (
    <div style={{ borderBottom: `1px solid ${colors.border}`, flexShrink: 0 }}>
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          cursor: 'pointer',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '6px 14px',
          background: colors.bgCard,
        }}
      >
        <span style={{ fontFamily: FONTS.pixel, fontSize: '7px', color: '#f97316', letterSpacing: 0.5 }}>
          MEETING LOG R{latest.round} ({latest.transcript.length} lines)
        </span>
        <span style={{ fontSize: 10, color: colors.textDim }}>{expanded ? '\u25BE' : '\u25B8'}</span>
      </div>
      {expanded && (
        <div style={{ padding: '4px 14px 8px', maxHeight: 250, overflowY: 'auto' }}>
          {latest.transcript.map((line, i) => (
            <div key={i} style={{
              padding: '3px 0',
              borderBottom: i < latest.transcript.length - 1 ? `1px solid ${colors.border}15` : undefined,
            }}>
              <span style={{ fontFamily: FONTS.body, fontSize: 11, color: '#f97316', fontWeight: 600 }}>
                {line.name}:
              </span>{' '}
              <span style={{ fontFamily: FONTS.body, fontSize: 11, color: colors.text }}>
                {line.message}
              </span>
            </div>
          ))}
          {transcripts.length > 1 && (
            <div style={{ fontFamily: FONTS.pixel, fontSize: '6px', color: colors.textDim, marginTop: 6, letterSpacing: 0.3 }}>
              {transcripts.length} meetings total
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export const WerewolfSidebar: React.FC = () => {
  const { colors } = useTheme();
  const [events, setEvents] = useState<WerewolfEvent[]>([]);
  const [filterType, setFilterType] = useState<WerewolfEventType | null>(null);

  const isMobile = useIsMobile();

  // Sync sidebar width so camera offset centers agent in visible area
  const sidebarWidth = isMobile ? 0 : 420;
  useEffect(() => {
    gameStore.setSidebarWidth(sidebarWidth);
    return () => { gameStore.setSidebarWidth(0); };
  }, [sidebarWidth]);

  const chatLog = useChatLog();
  const agentsMap = useAgentsMap();
  const agents = useAgents();
  const { phase, round } = useWerewolfPhase();
  const roles = useWerewolfRoles();
  const godMode = useWerewolfGodMode();
  const kills = useWerewolfKills();
  const votes = useWerewolfVotes();
  const nightActions = useWerewolfNightActions();
  const meetingTranscripts = useWerewolfMeetingTranscripts();

  const getName = (id: string) => agentsMap.get(id)?.config.name ?? '???';

  // Track which conversationIds we've already added as events
  const seenConvIds = useRef(new Set<string>());

  // Subscribe to werewolf events
  useEffect(() => {
    const addEvent = (e: WerewolfEvent) => setEvents(prev => [e, ...prev].slice(0, 300));

    const cleanups = [
      eventBus.on('werewolf:phase', (data: { phase: string; round: number }) => {
        const phaseIcons: Record<string, string> = {
          night: '\u{1F319}', dawn: '\u{1F305}', day: '\u2600',
          meeting: '\u{1F514}', vote: '\u{1F5F3}',
        };
        addEvent({
          id: crypto.randomUUID(),
          time: Date.now(),
          round: data.round,
          type: data.phase === 'meeting' ? 'meeting' : 'phase',
          icon: phaseIcons[data.phase] ?? '\u{1F305}',
          headline: data.phase === 'meeting'
            ? `TOWN MEETING \u2014 Day ${data.round}`
            : `${data.phase.toUpperCase()} \u2014 Round ${data.round}`,
        });
      }),

      eventBus.on('agent:death', (data: { agentId: string; cause: string }) => {
        const name = getName(data.agentId);
        const isExile = data.cause.includes('exile');
        const role = roles.get(data.agentId);
        addEvent({
          id: crypto.randomUUID(),
          time: Date.now(),
          round: gameStore.getState().werewolfRound,
          type: 'death',
          icon: isExile ? '\u{1F5F3}' : '\u{1F480}',
          headline: isExile
            ? `${name} was exiled by the village vote`
            : `${name} was found dead at dawn`,
          detail: role ? `Role revealed: ${role.toUpperCase()}` : undefined,
        });
      }),

      eventBus.on('werewolf:kill', (data: { agentId: string; saved: boolean }) => {
        if (data.saved) {
          const name = getName(data.agentId);
          addEvent({
            id: crypto.randomUUID(),
            time: Date.now(),
            round: gameStore.getState().werewolfRound,
            type: 'save',
            icon: '\u{1F6E1}',
            headline: `${name} was attacked but saved by the healer`,
          });
        }
      }),

      eventBus.on('werewolf:voteDetail', (data: { round: number; votes: Record<string, string>; result: 'exiled' | 'no_exile'; exiledId: string | null }) => {
        // Tally votes per target
        const tally: Record<string, string[]> = {};
        for (const [voterId, targetId] of Object.entries(data.votes)) {
          if (!tally[targetId]) tally[targetId] = [];
          tally[targetId].push(getName(voterId));
        }

        // Build breakdown: "Elena: 3 votes (Marcus, Sofia, Finn)"
        const tallyLines = Object.entries(tally)
          .sort(([, a], [, b]) => b.length - a.length)
          .map(([targetId, voters]) => `${getName(targetId)}: ${voters.length} vote${voters.length !== 1 ? 's' : ''} (${voters.join(', ')})`)
          .join('\n');

        const exiledName = data.exiledId ? getName(data.exiledId) : null;
        const topVotes = data.exiledId && tally[data.exiledId] ? tally[data.exiledId].length : 0;
        const headline = data.result === 'exiled' && exiledName
          ? `Vote: ${exiledName} EXILED (${topVotes} vote${topVotes !== 1 ? 's' : ''})`
          : 'Vote: NO EXILE (tied)';

        addEvent({
          id: crypto.randomUUID(),
          time: Date.now(),
          round: data.round,
          type: 'vote',
          icon: data.result === 'exiled' ? '\u{1F6A8}' : '\u{1F6E1}',
          headline,
          detail: tallyLines,
        });
      }),

      eventBus.on('werewolf:reveal', (data: { agentId: string; role: string }) => {
        // Only show reveals during active game (not initial assignment)
        if (phase && phase !== 'setup') {
          addEvent({
            id: crypto.randomUUID(),
            time: Date.now(),
            round: gameStore.getState().werewolfRound,
            type: 'role',
            icon: '\u{1F3AD}',
            headline: `${getName(data.agentId)}'s role revealed: ${data.role.toUpperCase()}`,
          });
        }
      }),

      eventBus.on('werewolf:nightAction', (data: { type: string; agentId: string; targetId: string; result?: string }) => {
        const r = gameStore.getState().werewolfRound;
        let headline = '';
        let icon = '\u{1F43A}';
        switch (data.type) {
          case 'wolfTarget':
            headline = `Wolves targeted ${getName(data.targetId)}`;
            icon = '\u{1F43A}';
            break;
          case 'healerGuard':
            headline = `Healer protected ${getName(data.targetId)}`;
            icon = '\u{1F6E1}';
            break;
          case 'sheriffResult':
            headline = `Sheriff investigated ${getName(data.targetId)}: ${(data.result ?? 'unknown').toUpperCase()}`;
            icon = '\u{1F50D}';
            break;
        }
        addEvent({
          id: crypto.randomUUID(),
          time: Date.now(),
          round: r,
          type: 'night',
          icon,
          headline,
          detail: `by ${getName(data.agentId)}`,
        });
      }),
    ];

    return () => cleanups.forEach(fn => fn());
  }, [agentsMap, phase, roles]);

  // Convert new conversations into events
  useEffect(() => {
    const grouped = new Map<string, ChatEntry[]>();
    for (const entry of chatLog) {
      const key = entry.conversationId || entry.id;
      const arr = grouped.get(key);
      if (arr) arr.push(entry);
      else grouped.set(key, [entry]);
    }

    for (const [convId, msgs] of grouped) {
      if (seenConvIds.current.has(convId)) continue;
      if (msgs.length < 2) continue; // wait for at least an exchange
      seenConvIds.current.add(convId);
      const participants = [...new Set(msgs.map(m => m.agentName))];
      const isMeeting = msgs.some(m => m.phase === 'meeting');
      setEvents(prev => [{
        id: `conv-${convId}`,
        time: msgs[0]?.timestamp ?? Date.now(),
        round: gameStore.getState().werewolfRound,
        type: (isMeeting ? 'meeting' : 'conversation') as WerewolfEventType,
        icon: isMeeting ? '\u{1F514}' : '\u{1F4AC}',
        headline: isMeeting
          ? `${participants.join(' & ')} spoke at the meeting`
          : `${participants.join(' & ')} are talking`,
        conversationId: convId,
        agentNames: participants,
      }, ...prev].slice(0, 300));
    }
  }, [chatLog]);

  // No auto-scroll — user controls their own scroll position

  const totalCount = agents.length;
  const aliveCount = agents.filter(a => a.alive !== false).length;
  const deadCount = agents.filter(a => a.alive === false).length;

  // Filter events — hide 'night' type unless god mode is on
  const visibleEvents = events.filter(e => {
    if (e.type === 'night' && !godMode) return false;
    if (filterType && e.type !== filterType) return false;
    return true;
  });

  // Count by type (for filter chips) — seed all types so chips are always visible
  const allTypes: WerewolfEventType[] = ['phase', 'conversation', 'meeting', 'vote', 'death', 'save', 'role'];
  if (godMode) allTypes.push('night');
  const typeCounts = new Map<WerewolfEventType, number>(allTypes.map(t => [t, 0]));
  for (const e of events) {
    if (e.type === 'night' && !godMode) continue;
    typeCounts.set(e.type, (typeCounts.get(e.type) ?? 0) + 1);
  }

  return (
    <div style={{
      position: 'absolute',
      top: 0,
      right: 0,
      width: isMobile ? '100%' : 420,
      bottom: 0,
      background: colors.bg,
      borderLeft: `1px solid ${colors.border}`,
      display: 'flex',
      flexDirection: 'column',
      zIndex: 12,
      pointerEvents: 'auto',
    }}>
      {/* ── Upper section (header + roster + votes + meetings) — capped height, scrollable ── */}
      <div style={{ maxHeight: '40vh', overflowY: 'auto', flexShrink: 0, overscrollBehavior: 'contain' }}>
        <SidebarHeader
          phase={phase}
          round={round}
          godMode={godMode}
          totalCount={totalCount}
          aliveCount={aliveCount}
          deadCount={deadCount}
          roles={roles}
          agentsMap={agentsMap}
        />

        {agents.length > 0 && (
          <VillagerRoster agents={agents} roles={roles} godMode={godMode} />
        )}

        <VoteTracker votes={votes} getName={getName} currentRound={round} phase={phase} />

        <MeetingLog transcripts={meetingTranscripts} />
      </div>

      {/* ── Filter chips (always visible) ── */}
      <div style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 4,
        padding: '8px 10px',
        borderBottom: `1px solid ${colors.border}`,
        flexShrink: 0,
      }}>
        <FilterChip
          label={`ALL (${events.filter(e => e.type !== 'night' || godMode).length})`}
          active={filterType === null}
          color={colors.accent}
          onClick={() => setFilterType(null)}
        />
        {([...typeCounts.entries()] as [WerewolfEventType, number][]).map(([type, count]) => {
          const badge = EVENT_BADGES[type];
          return (
            <FilterChip
              key={type}
              label={`${badge.icon} ${badge.label} (${count})`}
              active={filterType === type}
              color={badge.color}
              onClick={() => setFilterType(prev => prev === type ? null : type)}
            />
          );
        })}
      </div>

      {/* ── Event feed ── */}
      <div style={{ flex: 1, overflowY: 'auto', overscrollBehavior: 'contain' }}>
        {visibleEvents.length === 0 && (
          <div style={{
            padding: '40px 20px',
            textAlign: 'center',
            color: colors.textDim,
            fontFamily: FONTS.body,
            fontSize: 13,
            lineHeight: 1.6,
          }}>
            {!phase
              ? 'Start the game to see events here.\nAgents will talk, vote, and reveal roles.'
              : 'No events yet. Watch as the game unfolds...'}
          </div>
        )}
        {visibleEvents.map(event => (
          <EventCard
            key={event.id}
            event={event}
            chatLog={chatLog}
            roles={roles}
            godMode={godMode}
            getName={getName}
          />
        ))}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

const SidebarHeader: React.FC<{
  phase: string | null;
  round: number;
  godMode: boolean;
  totalCount: number;
  aliveCount: number;
  deadCount: number;
  roles: Map<string, string>;
  agentsMap: Map<string, { config: { name: string }; alive?: boolean }>;
}> = ({ phase, round, godMode, totalCount, aliveCount, deadCount, roles, agentsMap }) => {
  const { colors } = useTheme();
  return (
    <div style={{
      padding: '12px 14px',
      borderBottom: `1px solid ${colors.border}`,
      flexShrink: 0,
      background: colors.bgCard,
    }}>
      {/* Row 1: Title + controls */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontFamily: FONTS.pixel, fontSize: '9px', color: colors.accent, letterSpacing: 1 }}>
            WEREWOLF
          </span>
          {phase && (
            <span style={{
              fontFamily: FONTS.pixel, fontSize: '9px', letterSpacing: 1,
              padding: '2px 8px', borderRadius: 3,
              background: (PHASE_COLORS[phase] ?? '#9ca3af') + '33',
              color: PHASE_COLORS[phase] ?? '#9ca3af',
            }}>
              {phase.toUpperCase()} R{round}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {!phase && (
            <button
              onClick={() => { if (totalCount >= 6) { devResume(); werewolfStart(); } }}
              style={{
                padding: '4px 12px',
                background: totalCount >= 6 ? '#4ade8022' : 'transparent',
                border: `1px solid ${totalCount >= 6 ? '#4ade80' : colors.border}`,
                borderRadius: 4,
                cursor: totalCount >= 6 ? 'pointer' : 'not-allowed',
                fontFamily: FONTS.pixel, fontSize: '7px', letterSpacing: 1,
                color: totalCount >= 6 ? '#4ade80' : colors.textDim,
                opacity: totalCount >= 6 ? 1 : 0.5,
              }}
            >
              START GAME
            </button>
          )}
          {phase && (
            <button
              onClick={() => gameStore.toggleWerewolfGodMode()}
              style={{
                padding: '4px 10px',
                background: godMode ? '#ef444422' : 'transparent',
                border: `1px solid ${godMode ? '#ef4444' : colors.border}`,
                borderRadius: 4,
                cursor: 'pointer',
                fontFamily: FONTS.pixel, fontSize: '6px', letterSpacing: 0.5,
                color: godMode ? '#ef4444' : colors.textDim,
                transition: 'all 0.15s',
              }}
            >
              {godMode ? 'HIDE ROLES' : 'GOD MODE'}
            </button>
          )}
        </div>
      </div>

      {/* Row 2: Alive/dead + role badges (god mode) */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6, flexWrap: 'wrap' }}>
        <span style={{ fontFamily: FONTS.pixel, fontSize: '6px', letterSpacing: 0.5, color: '#4ade80' }}>
          {aliveCount} ALIVE
        </span>
        {deadCount > 0 && (
          <span style={{ fontFamily: FONTS.pixel, fontSize: '6px', letterSpacing: 0.5, color: '#ef4444' }}>
            {deadCount} DEAD
          </span>
        )}
        {!phase && (
          <span style={{ fontFamily: FONTS.pixel, fontSize: '6px', letterSpacing: 0.5, color: colors.textDim }}>
            {aliveCount >= 6 ? 'READY' : `NEED ${6 - aliveCount} MORE`}
          </span>
        )}
      </div>

      {/* Row 3: God mode role roster */}
      {godMode && roles.size > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 8 }}>
          {[...roles.entries()].map(([id, role]) => {
            const name = agentsMap.get(id)?.config.name ?? '?';
            const dead = agentsMap.get(id)?.alive === false;
            return (
              <span
                key={id}
                style={{
                  fontFamily: FONTS.pixel, fontSize: '5px', letterSpacing: 0.5,
                  padding: '2px 6px', borderRadius: 3,
                  border: `1px solid ${ROLE_COLORS[role] ?? '#666'}`,
                  color: dead ? '#555' : ROLE_COLORS[role],
                  background: dead ? 'transparent' : `${ROLE_COLORS[role]}15`,
                  textDecoration: dead ? 'line-through' : 'none',
                  opacity: dead ? 0.5 : 1,
                }}
              >
                {name} \u2014 {role}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Filter Chip
// ---------------------------------------------------------------------------

const FilterChip: React.FC<{
  label: string;
  active: boolean;
  color: string;
  onClick: () => void;
}> = ({ label, active, color, onClick }) => {
  const { colors } = useTheme();
  return (<button
    onClick={onClick}
    style={{
      padding: '3px 8px',
      borderRadius: 4,
      border: `1px solid ${active ? color : colors.border}`,
      background: active ? color + '22' : 'transparent',
      color: active ? color : colors.textDim,
      fontFamily: FONTS.pixel,
      fontSize: '5px',
      letterSpacing: 0.5,
      cursor: 'pointer',
      transition: 'all 0.15s',
      whiteSpace: 'nowrap',
    }}
  >
    {label}
  </button>);
};

// ---------------------------------------------------------------------------
// Event Card
// ---------------------------------------------------------------------------

const EventCard: React.FC<{
  event: WerewolfEvent;
  chatLog: ChatEntry[];
  roles: Map<string, string>;
  godMode: boolean;
  getName: (id: string) => string;
}> = ({ event, chatLog, roles, godMode, getName }) => {
  const { colors } = useTheme();
  const [expanded, setExpanded] = useState(false);
  const badge = EVENT_BADGES[event.type];

  // Get conversation messages if this is a conversation event
  const convMessages = event.conversationId
    ? chatLog.filter(e => e.conversationId === event.conversationId).slice(-20)
    : [];

  const isExpandable = event.type === 'conversation' && convMessages.length > 0;

  return (
    <div
      onClick={() => { if (isExpandable) setExpanded(prev => !prev); }}
      onMouseEnter={e => { e.currentTarget.style.background = colors.bgHover; }}
      onMouseLeave={e => { e.currentTarget.style.background = colors.bgCard; }}
      style={{
        margin: '6px 10px',
        padding: '12px 14px',
        background: colors.bgCard,
        borderRadius: 8,
        border: `1px solid ${colors.border}`,
        cursor: isExpandable ? 'pointer' : undefined,
        transition: 'background 0.15s ease',
      }}
    >
      {/* Header: icon + type badge + round */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 14 }}>{event.icon}</span>
        <span style={{
          fontFamily: FONTS.pixel,
          fontSize: '9px',
          padding: '2px 6px',
          borderRadius: 3,
          background: badge.color + '33',
          color: badge.color,
          letterSpacing: 0.5,
        }}>
          {badge.label}
        </span>
        {event.agentNames && event.agentNames.length > 0 && (
          <span style={{ fontFamily: FONTS.body, fontSize: 11, color: colors.textDim }}>
            {event.agentNames.join(', ')}
          </span>
        )}
        {/* Right-aligned round + expand hint */}
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
          {isExpandable && !expanded && (
            <span style={{ fontFamily: FONTS.pixel, fontSize: '5px', color: colors.textDim }}>
              {convMessages.length} msg
            </span>
          )}
          <span style={{ fontFamily: FONTS.pixel, fontSize: '6px', color: colors.textDim }}>
            R{event.round}
          </span>
        </span>
      </div>

      {/* Headline */}
      <div style={{
        fontFamily: FONTS.body,
        fontSize: 13,
        color: colors.text,
        lineHeight: 1.5,
        whiteSpace: 'pre-wrap',
      }}>
        {event.headline}
      </div>

      {/* Detail line */}
      {event.detail && (
        <div style={{
          fontFamily: FONTS.body,
          fontSize: 11,
          color: colors.textDim,
          marginTop: 4,
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
        }}>
          {event.detail}
        </div>
      )}

      {/* Vote result badge for vote events */}
      {event.type === 'vote' && (
        <div style={{ marginTop: 6 }}>
          <span style={{
            fontFamily: FONTS.pixel,
            fontSize: '7px',
            padding: '2px 8px',
            borderRadius: 3,
            background: event.headline.includes('EXILED') ? '#ef444433' : '#4ade8033',
            color: event.headline.includes('EXILED') ? '#ef4444' : '#4ade80',
          }}>
            {event.headline.includes('EXILED') ? 'EXILED' : 'SAVED'}
          </span>
        </div>
      )}

      {/* Death role reveal badge */}
      {event.type === 'death' && event.detail && (
        <div style={{ marginTop: 6 }}>
          {(() => {
            const roleMatch = event.detail.match(/Role revealed: (\w+)/i);
            const role = roleMatch?.[1]?.toLowerCase() ?? '';
            return (
              <span style={{
                fontFamily: FONTS.pixel,
                fontSize: '7px',
                padding: '2px 8px',
                borderRadius: 3,
                background: (ROLE_COLORS[role] ?? '#6b7280') + '33',
                color: ROLE_COLORS[role] ?? '#6b7280',
              }}>
                {role.toUpperCase() || 'UNKNOWN'}
              </span>
            );
          })()}
        </div>
      )}

      {/* Expanded conversation */}
      {expanded && convMessages.length > 0 && (
        <div style={{
          marginTop: 10,
          paddingTop: 8,
          borderTop: `1px solid ${colors.border}44`,
          maxHeight: 240,
          overflowY: 'auto',
        }}>
          {convMessages.map(msg => (
            <div key={msg.id} style={{
              padding: '4px 0',
              borderBottom: `1px solid ${colors.border}15`,
            }}>
              <span style={{
                fontFamily: FONTS.pixel,
                fontSize: '6px',
                color: colors.accent,
                marginRight: 6,
              }}>
                {msg.agentName}
              </span>
              <span style={{
                fontFamily: FONTS.body,
                fontSize: 12,
                color: colors.text,
                lineHeight: 1.4,
              }}>
                {msg.message}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
