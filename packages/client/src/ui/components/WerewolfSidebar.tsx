import React, { useEffect, useRef, useState } from 'react';
import { COLORS, FONTS } from '../styles';
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
} from '../../core/hooks';
import { gameStore } from '../../core/GameStore';
import { eventBus } from '../../core/EventBus';
import { werewolfStart } from '../../network/socket';
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
  const [expanded, setExpanded] = useState(true);
  const aliveAgents = agents.filter(a => a.alive !== false);
  const deadAgents = agents.filter(a => a.alive === false);
  const sorted = [...aliveAgents, ...deadAgents];

  return (
    <div style={{ borderBottom: `1px solid ${COLORS.border}`, flexShrink: 0 }}>
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          cursor: 'pointer',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '6px 14px',
          background: COLORS.bgCard,
        }}
      >
        <span style={{ fontFamily: FONTS.pixel, fontSize: '7px', color: COLORS.textDim, letterSpacing: 0.5 }}>
          VILLAGERS ({aliveAgents.length} alive)
        </span>
        <span style={{ fontSize: 10, color: COLORS.textDim }}>{expanded ? '\u25BE' : '\u25B8'}</span>
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
                  color: isDead ? COLORS.textDim : COLORS.text,
                  textDecoration: isDead ? 'line-through' : 'none',
                }}>
                  {agent.config.name}
                  {role ? (
                    <span style={{ color: godMode ? (ROLE_COLORS[role] ?? COLORS.textDim) : COLORS.textDim }}>
                      {' '}({godMode ? role.charAt(0).toUpperCase() + role.slice(1) : 'Villager'})
                    </span>
                  ) : (
                    <span style={{ color: COLORS.textDim }}> (Unassigned)</span>
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
  votes: Array<{ round: number; callerId: string; nomineeId: string; votes: Record<string, 'exile' | 'save'>; result: 'exiled' | 'saved' }>;
  getName: (id: string) => string;
  currentRound: number;
  phase: string | null;
}> = ({ votes, getName, currentRound, phase }) => {
  if (votes.length === 0) return null;

  // Show most recent vote first
  const sorted = [...votes].reverse();

  return (
    <div style={{ borderBottom: `1px solid ${COLORS.border}`, flexShrink: 0 }}>
      <div style={{
        padding: '6px 14px',
        background: COLORS.bgCard,
        fontFamily: FONTS.pixel,
        fontSize: '7px',
        color: COLORS.textDim,
        letterSpacing: 0.5,
      }}>
        VOTES ({votes.length})
      </div>
      <div style={{ padding: '4px 14px 8px', maxHeight: 180, overflowY: 'auto' }}>
        {sorted.map((vote, i) => {
          const exileCount = Object.values(vote.votes).filter(v => v === 'exile').length;
          const saveCount = Object.values(vote.votes).filter(v => v === 'save').length;
          const isExiled = vote.result === 'exiled';

          return (
            <div key={i} style={{
              padding: '6px 0',
              borderBottom: i < sorted.length - 1 ? `1px solid ${COLORS.border}22` : undefined,
            }}>
              {/* Vote header */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <span style={{
                  fontFamily: FONTS.pixel, fontSize: '6px', letterSpacing: 0.3,
                  color: COLORS.textDim,
                }}>
                  R{vote.round}
                </span>
                <span style={{ fontFamily: FONTS.body, fontSize: 12, color: COLORS.text }}>
                  {getName(vote.nomineeId)}
                </span>
                <span style={{
                  fontFamily: FONTS.pixel, fontSize: '6px',
                  padding: '1px 6px', borderRadius: 3,
                  background: isExiled ? '#ef444433' : '#4ade8033',
                  color: isExiled ? '#ef4444' : '#4ade80',
                  letterSpacing: 0.3,
                }}>
                  {isExiled ? 'EXILED' : 'SAVED'}
                </span>
                <span style={{
                  marginLeft: 'auto',
                  fontFamily: FONTS.pixel, fontSize: '6px', color: COLORS.textDim,
                }}>
                  {exileCount}-{saveCount}
                </span>
              </div>
              {/* Individual votes */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
                {Object.entries(vote.votes).map(([id, v]) => (
                  <span key={id} style={{
                    fontFamily: FONTS.body, fontSize: 10,
                    padding: '1px 5px', borderRadius: 3,
                    background: v === 'exile' ? '#ef444418' : '#4ade8018',
                    color: v === 'exile' ? '#ef4444' : '#4ade80',
                    border: `1px solid ${v === 'exile' ? '#ef444433' : '#4ade8033'}`,
                  }}>
                    {getName(id)}: {v}
                  </span>
                ))}
              </div>
              {/* Called by */}
              <div style={{ fontFamily: FONTS.body, fontSize: 10, color: COLORS.textDim, marginTop: 3 }}>
                Called by {getName(vote.callerId)}
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
  const [expanded, setExpanded] = useState(false);
  if (transcripts.length === 0) return null;

  // Show most recent meeting first
  const latest = transcripts[transcripts.length - 1];

  return (
    <div style={{ borderBottom: `1px solid ${COLORS.border}`, flexShrink: 0 }}>
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          cursor: 'pointer',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '6px 14px',
          background: COLORS.bgCard,
        }}
      >
        <span style={{ fontFamily: FONTS.pixel, fontSize: '7px', color: '#f97316', letterSpacing: 0.5 }}>
          MEETING LOG R{latest.round} ({latest.transcript.length} lines)
        </span>
        <span style={{ fontSize: 10, color: COLORS.textDim }}>{expanded ? '\u25BE' : '\u25B8'}</span>
      </div>
      {expanded && (
        <div style={{ padding: '4px 14px 8px', maxHeight: 250, overflowY: 'auto' }}>
          {latest.transcript.map((line, i) => (
            <div key={i} style={{
              padding: '3px 0',
              borderBottom: i < latest.transcript.length - 1 ? `1px solid ${COLORS.border}15` : undefined,
            }}>
              <span style={{ fontFamily: FONTS.body, fontSize: 11, color: '#f97316', fontWeight: 600 }}>
                {line.name}:
              </span>{' '}
              <span style={{ fontFamily: FONTS.body, fontSize: 11, color: COLORS.text }}>
                {line.message}
              </span>
            </div>
          ))}
          {transcripts.length > 1 && (
            <div style={{ fontFamily: FONTS.pixel, fontSize: '6px', color: COLORS.textDim, marginTop: 6, letterSpacing: 0.3 }}>
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
  const [events, setEvents] = useState<WerewolfEvent[]>([]);
  const [filterType, setFilterType] = useState<WerewolfEventType | null>(null);

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

      eventBus.on('werewolf:voteDetail', (data: { round: number; callerId: string; nomineeId: string; votes: Record<string, 'exile' | 'save'>; result: 'exiled' | 'saved' }) => {
        const callerName = getName(data.callerId);
        const nomineeName = getName(data.nomineeId);
        let exileCount = 0;
        let saveCount = 0;
        for (const v of Object.values(data.votes)) {
          if (v === 'exile') exileCount++;
          else saveCount++;
        }
        const voteBreakdown = Object.entries(data.votes)
          .map(([id, v]) => `${getName(id)}: ${v}`)
          .join(', ');

        addEvent({
          id: crypto.randomUUID(),
          time: Date.now(),
          round: data.round,
          type: 'vote',
          icon: data.result === 'exiled' ? '\u{1F6A8}' : '\u{1F6E1}',
          headline: `Vote on ${nomineeName}: ${data.result.toUpperCase()} (${exileCount}-${saveCount})`,
          detail: `Called by ${callerName}\n${voteBreakdown}`,
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
      setEvents(prev => [{
        id: `conv-${convId}`,
        time: msgs[0]?.timestamp ?? Date.now(),
        round: gameStore.getState().werewolfRound,
        type: 'conversation' as WerewolfEventType,
        icon: '\u{1F4AC}',
        headline: `${participants.join(' & ')} are talking`,
        conversationId: convId,
        agentNames: participants,
      }, ...prev].slice(0, 300));
    }
  }, [chatLog]);

  // No auto-scroll — user controls their own scroll position

  const aliveCount = agents.filter(a => a.alive !== false).length;
  const deadCount = agents.filter(a => a.alive === false).length;

  // Filter events — hide 'night' type unless god mode is on
  const visibleEvents = events.filter(e => {
    if (e.type === 'night' && !godMode) return false;
    if (filterType && e.type !== filterType) return false;
    return true;
  });

  // Count by type (for filter chips)
  const typeCounts = new Map<WerewolfEventType, number>();
  for (const e of events) {
    if (e.type === 'night' && !godMode) continue;
    typeCounts.set(e.type, (typeCounts.get(e.type) ?? 0) + 1);
  }

  return (
    <div style={{
      position: 'absolute',
      top: 0,
      right: 0,
      width: 420,
      bottom: 0,
      background: COLORS.bg,
      borderLeft: `1px solid ${COLORS.border}`,
      display: 'flex',
      flexDirection: 'column',
      zIndex: 12,
      pointerEvents: 'auto',
    }}>
      {/* ── Header ── */}
      <SidebarHeader
        phase={phase}
        round={round}
        godMode={godMode}
        aliveCount={aliveCount}
        deadCount={deadCount}
        roles={roles}
        agentsMap={agentsMap}
      />

      {/* ── Villager Roster ── */}
      {agents.length > 0 && (
        <VillagerRoster agents={agents} roles={roles} godMode={godMode} />
      )}

      {/* ── Vote Tracker ── */}
      <VoteTracker votes={votes} getName={getName} currentRound={round} phase={phase} />

      {/* ── Meeting Log ── */}
      <MeetingLog transcripts={meetingTranscripts} />

      {/* ── Filter chips ── */}
      {events.length > 0 && (
        <div style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 4,
          padding: '8px 10px',
          borderBottom: `1px solid ${COLORS.border}`,
          flexShrink: 0,
        }}>
          <FilterChip
            label={`ALL (${events.filter(e => e.type !== 'night' || godMode).length})`}
            active={filterType === null}
            color={COLORS.accent}
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
      )}

      {/* ── Event feed ── */}
      <div style={{ flex: 1, overflowY: 'auto', overscrollBehavior: 'contain' }}>
        {visibleEvents.length === 0 && (
          <div style={{
            padding: '40px 20px',
            textAlign: 'center',
            color: COLORS.textDim,
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
  aliveCount: number;
  deadCount: number;
  roles: Map<string, string>;
  agentsMap: Map<string, { config: { name: string }; alive?: boolean }>;
}> = ({ phase, round, godMode, aliveCount, deadCount, roles, agentsMap }) => {
  return (
    <div style={{
      padding: '12px 14px',
      borderBottom: `1px solid ${COLORS.border}`,
      flexShrink: 0,
      background: COLORS.bgCard,
    }}>
      {/* Row 1: Title + controls */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontFamily: FONTS.pixel, fontSize: '9px', color: COLORS.accent, letterSpacing: 1 }}>
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
              onClick={() => aliveCount >= 6 && werewolfStart()}
              style={{
                padding: '4px 12px',
                background: aliveCount >= 6 ? '#4ade8022' : 'transparent',
                border: `1px solid ${aliveCount >= 6 ? '#4ade80' : COLORS.border}`,
                borderRadius: 4,
                cursor: aliveCount >= 6 ? 'pointer' : 'not-allowed',
                fontFamily: FONTS.pixel, fontSize: '7px', letterSpacing: 1,
                color: aliveCount >= 6 ? '#4ade80' : COLORS.textDim,
                opacity: aliveCount >= 6 ? 1 : 0.5,
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
                border: `1px solid ${godMode ? '#ef4444' : COLORS.border}`,
                borderRadius: 4,
                cursor: 'pointer',
                fontFamily: FONTS.pixel, fontSize: '6px', letterSpacing: 0.5,
                color: godMode ? '#ef4444' : COLORS.textDim,
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
          <span style={{ fontFamily: FONTS.pixel, fontSize: '6px', letterSpacing: 0.5, color: COLORS.textDim }}>
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
}> = ({ label, active, color, onClick }) => (
  <button
    onClick={onClick}
    style={{
      padding: '3px 8px',
      borderRadius: 4,
      border: `1px solid ${active ? color : COLORS.border}`,
      background: active ? color + '22' : 'transparent',
      color: active ? color : COLORS.textDim,
      fontFamily: FONTS.pixel,
      fontSize: '5px',
      letterSpacing: 0.5,
      cursor: 'pointer',
      transition: 'all 0.15s',
      whiteSpace: 'nowrap',
    }}
  >
    {label}
  </button>
);

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
      onMouseEnter={e => { e.currentTarget.style.background = COLORS.bgHover; }}
      onMouseLeave={e => { e.currentTarget.style.background = COLORS.bgCard; }}
      style={{
        margin: '6px 10px',
        padding: '12px 14px',
        background: COLORS.bgCard,
        borderRadius: 8,
        border: `1px solid ${COLORS.border}`,
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
          <span style={{ fontFamily: FONTS.body, fontSize: 11, color: COLORS.textDim }}>
            {event.agentNames.join(', ')}
          </span>
        )}
        {/* Right-aligned round + expand hint */}
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
          {isExpandable && !expanded && (
            <span style={{ fontFamily: FONTS.pixel, fontSize: '5px', color: COLORS.textDim }}>
              {convMessages.length} msg
            </span>
          )}
          <span style={{ fontFamily: FONTS.pixel, fontSize: '6px', color: COLORS.textDim }}>
            R{event.round}
          </span>
        </span>
      </div>

      {/* Headline */}
      <div style={{
        fontFamily: FONTS.body,
        fontSize: 13,
        color: COLORS.text,
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
          color: COLORS.textDim,
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
          borderTop: `1px solid ${COLORS.border}44`,
          maxHeight: 240,
          overflowY: 'auto',
        }}>
          {convMessages.map(msg => (
            <div key={msg.id} style={{
              padding: '4px 0',
              borderBottom: `1px solid ${COLORS.border}15`,
            }}>
              <span style={{
                fontFamily: FONTS.pixel,
                fontSize: '6px',
                color: COLORS.accent,
                marginRight: 6,
              }}>
                {msg.agentName}
              </span>
              <span style={{
                fontFamily: FONTS.body,
                fontSize: 12,
                color: COLORS.text,
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
