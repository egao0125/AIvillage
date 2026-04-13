import type { Agent, GameTime, MapAction, Position } from '@ai-village/shared';
import type { EventBus } from '@ai-village/shared';
import type { AgentCognition } from '@ai-village/ai-engine';
import { buildWerewolfRules } from '@ai-village/ai-engine';
import type { World } from '../world.js';
import type { EventBroadcaster } from '../events.js';
import type { AgentController } from '../agent-controller.js';
import type { ConversationManager } from '../conversation/index.js';
import type { WerewolfGameState, NightResult } from './types.js';
import { freshNightActions } from './types.js';
import { assignRoles, getWolfIds } from './role-assigner.js';
import {
  buildWolfNightPrompt,
  buildSheriffNightPrompt,
  buildHealerNightPrompt,
  buildDawnAnnouncement,
  buildDaySituationPrompt,
} from './prompts.js';
import { WerewolfVoteManager } from './vote-manager.js';

// ---------------------------------------------------------------------------
// Vote timeout (ticks) — only vote uses tick-based timeout; all other
// phases are driven by the world clock (GameTime).
// ---------------------------------------------------------------------------
const VOTE_TIMEOUT_TICKS = 480;  // ~40 seconds at 83ms tick (~4 game hours) — enough for all agents' LLM calls

// ---------------------------------------------------------------------------
// WerewolfPhaseManager — drives the entire werewolf game loop
// ---------------------------------------------------------------------------

export class WerewolfPhaseManager {
  private state: WerewolfGameState;
  private voteManager: WerewolfVoteManager;
  /** agentId → display name */
  private agentNames: Map<string, string> = new Map();
  /** Transcript of all speech during the current meeting — cleared each meeting */
  private meetingTranscript: Array<{ name: string; message: string }> = [];

  constructor(
    private bus: EventBus,
    private world: World,
    private broadcaster: EventBroadcaster,
    private controllers: Map<string, AgentController>,
    private cognitions: Map<string, AgentCognition>,
    private conversationManager: ConversationManager,
  ) {
    this.state = this.freshState();
    this.voteManager = new WerewolfVoteManager(this.state, this.broadcaster, this.world, this.controllers, this.cognitions);
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  get phase() { return this.state.phase; }
  get round() { return this.state.round; }
  get gameState() { return this.state; }

  /** List of alive agents with names — for vote prompt context */
  getAliveList(): Array<{ id: string; name: string }> {
    return [...this.state.alive].map(id => ({
      id,
      name: this.agentNames.get(id) ?? 'unknown',
    }));
  }

  /** Deaths so far — for vote prompt context */
  getDeaths(): Array<{ night: number; name: string; agentId: string }> {
    return this.state.dead.map(id => {
      // Find which night they died from event log
      const deathEvent = this.state.eventLog.find(
        e => e.phase === 'night' && e.event.includes('found dead') && e.agentIds?.includes(id),
      );
      // Also check for exile events
      const exileEvent = this.state.eventLog.find(
        e => e.event.includes('exiled') && e.agentIds?.includes(id),
      );
      const night = deathEvent?.day ?? exileEvent?.day ?? 0;
      return { night, name: this.agentNames.get(id) ?? 'unknown', agentId: id };
    });
  }

  /** Number of agents still alive */
  getAliveCount(): number { return this.state.alive.size; }

  /** Number of wolves still alive (internal — for wolf agents only) */
  getWolfCount(): number {
    let count = 0;
    for (const id of this.state.alive) {
      if (this.state.roles.get(id) === 'werewolf') count++;
    }
    return count;
  }


  startGame(agentIds: string[]): void {
    if (agentIds.length < 6) {
      console.warn(`[Werewolf] Need at least 6 agents, got ${agentIds.length}`);
      return;
    }

    // Build name lookup
    this.agentNames.clear();
    for (const id of agentIds) {
      const agent = this.world.getAgent(id);
      if (agent) this.agentNames.set(id, agent.config.name);
    }

    // Wipe all agent memories from previous games — fresh start
    for (const id of agentIds) {
      const cognition = this.cognitions.get(id);
      if (cognition?.fourStream) {
        cognition.fourStream.reset();
      }
    }

    // Assign roles
    const roles = assignRoles(agentIds);
    this.state = this.freshState();
    this.state.roles = roles;
    this.state.alive = new Set(agentIds);
    this.voteManager = new WerewolfVoteManager(this.state, this.broadcaster, this.world, this.controllers, this.cognitions);

    // Stamp roles onto Agent objects
    const wolfIds = getWolfIds(roles);
    for (const [id, role] of roles) {
      const agent = this.world.getAgent(id);
      if (!agent) continue;
      agent.werewolfRole = role;
      if (role === 'werewolf') {
        agent.fellowWolves = wolfIds.filter(wid => wid !== id);
      }
    }

    // Set per-role game rules via gameRulesOverride on each agent's cognition.
    // This replaces the shared game rules with role-specific ones so each agent
    // sees different instructions (wolf vs sheriff vs healer vs villager).
    for (const id of agentIds) {
      const cognition = this.cognitions.get(id);
      if (!cognition) continue;
      const role = roles.get(id)!;
      const fellowWolfName = role === 'werewolf'
        ? this.agentNames.get(wolfIds.find(wid => wid !== id) ?? '') ?? undefined
        : undefined;
      const perRoleRules = buildWerewolfRules(role, fellowWolfName, agentIds.length);
      cognition.setGameRules(perRoleRules);
      cognition.gameMode = 'werewolf';
    }

    console.log(`[Werewolf] Game started with ${agentIds.length} agents. Roles: ${[...roles.entries()].map(([id, r]) => `${this.agentNames.get(id)}=${r}`).join(', ')}`);

    // Broadcast all roles (client accumulates, only displays when god mode on)
    for (const [id, role] of roles) {
      this.broadcaster.werewolfReveal(id, role);
    }

    // Broadcast phase and start first night
    this.broadcaster.werewolfPhase('night', 1);
    this.state.phase = 'night';
    this.state.round = 1;
    this.state.phaseTimer = 0;
    this.transitionToNight();
  }

  /**
   * Called every engine tick when werewolf game is active.
   * Phase transitions are driven by the world clock, not tick counts.
   *
   * Schedule:
   *   21:00 → Night (villagers sleep, wolves/sheriff/healer act)
   *   05:00 → Dawn  (results announced)
   *   05:01 → Day   (free roam, conversations)
   *   12:00 → Meeting (all agents gather at plaza for structured discussion)
   *   14:00 → Vote (system triggers vote when meeting ends)
   *   14:30 → Afternoon (day resumes) if no vote called
   *   21:00 → Next night
   */
  onTick(time: GameTime): void {
    if (this.state.phase === 'setup' || this.state.phase === 'ended') return;

    this.state.phaseTimer++;
    const { hour, minute } = time;

    switch (this.state.phase) {
      case 'night':
        // Night ends at 05:00 OR when all night actions complete
        if ((hour === 5 && minute === 0) || this.allNightActionsComplete()) {
          this.resolveNight();
          this.transitionToDawn();
        }
        break;

      case 'dawn':
        // Dawn is brief — transitions to day at 05:01
        if (hour >= 5 && minute >= 1) {
          this.transitionToDay();
        }
        break;

      case 'day':
        // Meeting starts at 12:00
        if (hour === 12 && minute === 0) {
          this.transitionToMeeting();
        }
        // Execute condemned at 17:00 (or immediately if clock already past 17:00)
        if (hour >= 17 && this.state.pendingExileId) {
          const name = this.agentNames.get(this.state.pendingExileId) ?? 'someone';
          console.log(`[Werewolf] Executing ${name} at ${hour}:${String(minute).padStart(2, '0')}`);
          this.exileAgent(this.state.pendingExileId);
          this.state.pendingExileId = null;
          const winner = this.checkWin();
          if (winner) {
            this.endGame(winner);
            return;
          }
        }
        // Night starts at 21:00
        if (hour === 21 && minute === 0) {
          this.advanceToNextNight();
        }
        break;

      case 'meeting':
        // At 14:00, system triggers the vote (meeting runs 12:00–14:00 = ~20s real time)
        if (hour === 14 && minute === 0 && !this.state.voteCalled) {
          this.systemStartVote();
        }
        // Safety: if clock passed 14:30 without vote starting, force it
        if (hour >= 14 && minute >= 30 && !this.state.voteCalled) {
          this.systemStartVote();
        }
        break;

      case 'vote':
        this.voteManager.tick();
        if (this.voteManager.isComplete()) {
          this.handleVoteResult();
        } else if (this.state.phaseTimer >= VOTE_TIMEOUT_TICKS) {
          console.log(`[Werewolf] Vote timed out — forcing resolution with ${this.voteManager.getVoteCount()} votes`);
          this.voteManager.forceResolve();
          this.handleVoteResult();
        }
        break;
    }
  }

  /**
   * Returns the filtered action list for an agent based on current phase + role.
   */
  getActionsForAgent(agentId: string): MapAction[] {
    const role = this.state.roles.get(agentId);
    if (!role) return [];
    if (!this.state.alive.has(agentId)) return [];

    const actions: MapAction[] = [];

    switch (this.state.phase) {
      case 'night':
        // Only active roles get actions at night
        if (role === 'werewolf') {
          actions.push(
            { id: 'move_to', label: 'Move to location', category: 'movement' },
            { id: 'attack', label: 'Attack target', category: 'combat', requiresNearby: true },
            { id: 'change_target', label: 'Switch target', category: 'combat' },
          );
        } else if (role === 'sheriff') {
          actions.push(
            { id: 'move_to', label: 'Move to location', category: 'movement' },
            { id: 'investigate', label: 'Investigate agent', category: 'social', requiresNearby: true },
          );
        } else if (role === 'healer') {
          actions.push(
            { id: 'move_to', label: 'Move to location', category: 'movement' },
            { id: 'guard', label: 'Guard agent', category: 'survival', requiresNearby: true },
          );
        }
        // Villagers get no actions at night (sleeping)
        break;

      case 'day':
        actions.push(
          { id: 'move_to', label: 'Move to location', category: 'movement' },
          { id: 'talk', label: 'Talk to nearby agent', category: 'social', requiresNearby: true },
          { id: 'accuse', label: 'Publicly accuse', category: 'social' },
          { id: 'defend', label: 'Defend publicly', category: 'social' },
          { id: 'share_info', label: 'Share info publicly', category: 'social' },
          { id: 'reveal_role', label: 'Reveal your role', category: 'social' },
          { id: 'whisper', label: 'Whisper privately', category: 'social', requiresNearby: true },
          { id: 'observe', label: 'Watch who is talking', category: 'social' },
          { id: 'think', label: 'Reflect on evidence', category: 'rest' },
          { id: 'follow', label: 'Follow someone', category: 'movement', requiresNearby: true },
          { id: 'rest', label: 'Rest / Wait', category: 'rest' },
        );
        break;

      case 'meeting':
        actions.push(
          { id: 'talk', label: 'Talk to nearby agent', category: 'social', requiresNearby: true },
          { id: 'accuse', label: 'Publicly accuse', category: 'social' },
          { id: 'defend', label: 'Defend publicly', category: 'social' },
          { id: 'share_info', label: 'Share info publicly', category: 'social' },
          { id: 'reveal_role', label: 'Reveal your role', category: 'social' },
          { id: 'whisper', label: 'Whisper privately', category: 'social', requiresNearby: true },
          { id: 'observe', label: 'Watch who is talking', category: 'social' },
          { id: 'think', label: 'Reflect on evidence', category: 'rest' },
        );
        break;

      case 'vote':
        actions.push(
          { id: 'vote', label: 'Vote to exile someone', category: 'social' },
        );
        break;

      default:
        // dawn, setup, ended — no actions
        break;
    }

    return actions;
  }

  /**
   * Record a werewolf night action from an agent.
   */
  recordNightAction(agentId: string, actionId: string, targetId: string): void {
    const role = this.state.roles.get(agentId);
    if (this.state.phase !== 'night' || !role) return;

    // Reject actions targeting dead agents
    if (!this.state.alive.has(targetId)) {
      const targetName = this.agentNames.get(targetId) ?? 'that person';
      console.log(`[Werewolf] ${this.agentNames.get(agentId)} tried to target dead ${targetName} — rejected`);
      const cognition = this.cognitions.get(agentId);
      if (cognition) {
        void cognition.addMemory({
          id: crypto.randomUUID(),
          agentId,
          type: 'observation',
          content: `${targetName} is already dead. You must choose a living target.`,
          importance: 9,
          timestamp: Date.now(),
          relatedAgentIds: [],
        }).catch(() => {});
      }
      return;
    }

    switch (actionId) {
      case 'attack':
        if (role === 'werewolf') {
          // Wolves cannot attack fellow wolves
          if (this.state.roles.get(targetId) === 'werewolf') {
            const targetName = this.agentNames.get(targetId) ?? 'that person';
            console.log(`[Werewolf] Wolf tried to attack fellow wolf ${targetName} — rejected`);
            const cognition = this.cognitions.get(agentId);
            if (cognition) {
              void cognition.addMemory({
                id: crypto.randomUUID(),
                agentId,
                type: 'observation',
                content: `${targetName} is your fellow werewolf! You cannot attack them. Choose a VILLAGER target.`,
                importance: 10,
                timestamp: Date.now(),
                relatedAgentIds: [],
              }).catch(() => {});
            }
            return;
          }
          this.state.nightActions.wolfTarget = targetId;
          this.state.nightActions.wolfTargetConfirmed = true;
          console.log(`[Werewolf] Wolf ${this.agentNames.get(agentId)} attacks ${this.agentNames.get(targetId)}`);
        }
        break;

      case 'change_target':
        if (role === 'werewolf') {
          // Wolves cannot target fellow wolves
          if (this.state.roles.get(targetId) === 'werewolf') return;
          this.state.nightActions.wolfTarget = targetId;
          this.state.nightActions.wolfTargetConfirmed = false;
          console.log(`[Werewolf] Wolf ${this.agentNames.get(agentId)} changes target to ${this.agentNames.get(targetId)}`);
        }
        break;

      case 'investigate':
        if (role === 'sheriff') {
          this.state.nightActions.sheriffTarget = targetId;
          this.state.nightActions.sheriffDone = true;

          // Resolve investigation immediately for sheriff's private knowledge
          const targetRole = this.state.roles.get(targetId);
          const isWolf = targetRole === 'werewolf';
          const inv = {
            night: this.state.round,
            targetId,
            targetName: this.agentNames.get(targetId) ?? targetId,
            result: (isWolf ? 'werewolf' : 'not_werewolf') as 'werewolf' | 'not_werewolf',
          };
          this.state.investigations.push(inv);

          // Update agent's investigations field
          const agent = this.world.getAgent(agentId);
          if (agent) {
            if (!agent.investigations) agent.investigations = [];
            agent.investigations.push(inv);
          }

          // Private memory for sheriff
          const cognition = this.cognitions.get(agentId);
          if (cognition) {
            void cognition.addMemory({
              id: crypto.randomUUID(),
              agentId,
              type: 'observation',
              content: `Night ${this.state.round}: I investigated ${this.agentNames.get(targetId)}. Result: ${isWolf ? 'WEREWOLF!' : 'NOT a werewolf'}.`,
              importance: 10,
              isCore: true,
              keywords: ['investigation', 'sheriff', 'werewolf', 'evidence', this.agentNames.get(targetId)?.split(' ')[0]?.toLowerCase() ?? 'target'],
              timestamp: Date.now(),
              relatedAgentIds: [targetId],
            }).catch(() => {});
          }

          // Event log: sheriff investigation
          this.state.eventLog.push({
            day: this.state.round,
            phase: 'night',
            event: `${this.agentNames.get(agentId)} investigated ${this.agentNames.get(targetId)}: ${isWolf ? 'werewolf' : 'not werewolf'}`,
            agentIds: [agentId, targetId],
          });

          console.log(`[Werewolf] Sheriff investigates ${this.agentNames.get(targetId)} → ${isWolf ? 'WOLF' : 'clear'}`);
        }
        break;

      case 'guard':
        if (role === 'healer') {
          // Cannot guard same person as last night
          if (targetId === this.state.lastGuarded) {
            const targetName = this.agentNames.get(targetId) ?? 'that person';
            console.log(`[Werewolf] Healer tried to guard same person as last night — rejected`);
            // Tell the healer so they pick someone else
            const cognition = this.cognitions.get(agentId);
            if (cognition) {
              void cognition.addMemory({
                id: crypto.randomUUID(),
                agentId,
                type: 'observation',
                content: `You cannot guard ${targetName} again tonight — you must choose someone different from last night.`,
                importance: 9,
                timestamp: Date.now(),
                relatedAgentIds: [],
              }).catch(() => {});
            }
            return;
          }
          this.state.nightActions.healerGuard = targetId;
          this.state.nightActions.healerDone = true;

          // Update agent's lastGuarded
          const healerAgent = this.world.getAgent(agentId);
          if (healerAgent) {
            healerAgent.lastGuarded = targetId;
          }

          console.log(`[Werewolf] Healer guards ${this.agentNames.get(targetId)}`);
        }
        break;
    }
  }

  /**
   * System-triggered vote — called at 13:00 when meeting ends.
   */
  systemStartVote(): void {
    if (this.state.voteCalled) return;

    // Stop capturing meeting speech — we have the full transcript
    this.broadcaster.setOnSpeakHook(undefined);

    // Force-end the meeting group conversation if still active
    if (this.state.meetingConversationId) {
      const participants = this.conversationManager.forceEndConversation(this.state.meetingConversationId);
      for (const pid of participants) {
        const ctrl = this.controllers.get(pid);
        if (ctrl) ctrl.leaveConversation();
      }
      this.state.meetingConversationId = null;
    }

    // Compress timeline noise before vote — deduplicate accusations, preserve deaths/investigations
    for (const id of this.state.alive) {
      const cognition = this.cognitions.get(id);
      if (cognition?.fourStream) {
        cognition.fourStream.compressWerewolfTimeline();
      }
    }

    this.state.voteCalled = true;
    this.state.phase = 'vote';
    this.state.phaseTimer = 0;
    this.broadcaster.werewolfPhase('vote', this.state.round);

    // Send meeting transcript to clients for sidebar display
    this.broadcaster.werewolfMeetingTranscript(this.state.round, this.meetingTranscript);

    this.voteManager.startVote(this.meetingTranscript);

    console.log(`[Werewolf] System triggers vote — ${this.meetingTranscript.length} transcript lines — all agents must name their exile target`);
  }

  /**
   * Record a vote during vote phase.
   */
  recordVote(voterId: string, targetId: string): void {
    if (this.state.phase !== 'vote') return;
    this.voteManager.recordVote(voterId, targetId);
  }

  /**
   * Check if an agent should be sleeping (villagers during night).
   */
  shouldAgentSleep(agentId: string): boolean {
    if (this.state.phase !== 'night') return false;
    const role = this.state.roles.get(agentId);
    return role === 'villager';
  }

  /**
   * Check if conversations should be gated (night phase — only wolf-wolf allowed).
   */
  shouldBlockConversation(a1Id: string, a2Id: string): boolean {
    if (this.state.phase !== 'night') return false;
    const r1 = this.state.roles.get(a1Id);
    const r2 = this.state.roles.get(a2Id);
    // Only wolf-wolf conversations allowed at night
    if (r1 === 'werewolf' && r2 === 'werewolf') return false;
    return true;
  }

  /**
   * Get the night-phase situation prompt for an agent.
   */
  getNightPrompt(agentId: string): string | null {
    if (this.state.phase !== 'night') return null;
    const role = this.state.roles.get(agentId);
    switch (role) {
      case 'werewolf': return buildWolfNightPrompt(agentId, this.state, this.agentNames);
      case 'sheriff': return buildSheriffNightPrompt(this.state, this.agentNames);
      case 'healer': return buildHealerNightPrompt(this.state, this.agentNames);
      default: return null;
    }
  }

  /**
   * Get the day-phase situation prompt.
   */
  getDayPrompt(): string {
    return buildDaySituationPrompt(this.state, this.agentNames);
  }

  dispose(): void {
    this.broadcaster.setOnSpeakHook(undefined);
    this.state.phase = 'ended';
  }

  // -----------------------------------------------------------------------
  // Private — Phase Transitions
  // -----------------------------------------------------------------------

  private freshState(): WerewolfGameState {
    return {
      phase: 'setup',
      round: 0,
      roles: new Map(),
      alive: new Set(),
      dead: [],
      exiled: [],
      nightActions: freshNightActions(),
      lastNightResult: null,
      winner: null,
      phaseTimer: 0,
      investigations: [],
      lastGuarded: null,
      votingHistory: [],
      wolfConversationId: null,
      voteCalled: false,
      meetingConversationId: null,
      pendingExileId: null,
      eventLog: [],
    };
  }

  private transitionToNight(): void {
    this.state.nightActions = freshNightActions();
    this.state.phaseTimer = 0;

    // Put villagers to sleep — with context so they understand the gap
    for (const id of this.state.alive) {
      const role = this.state.roles.get(id);
      const agent = this.world.getAgent(id);
      if (!agent) continue;

      if (role === 'villager') {
        this.world.updateAgentState(id, 'sleeping', 'sleeping');
        const ctrl = this.controllers.get(id);
        if (ctrl) {
          ctrl.state = 'sleeping';
        }
        // Give villagers a sleep memory so they understand the time gap
        const cognition = this.cognitions.get(id);
        if (cognition) {
          void cognition.addMemory({
            id: crypto.randomUUID(),
            agentId: id,
            type: 'observation',
            content: `Night ${this.state.round} falls. As a villager with no special role, you go to sleep. You will not remember anything from tonight — only what is announced at dawn. Sleep well.`,
            importance: 5,
            timestamp: Date.now(),
            relatedAgentIds: [],
          }).catch(() => {});
        }
      } else {
        this.world.updateAgentState(id, 'active', '');
        // Inject night prompt into active roles
        const cognition = this.cognitions.get(id);
        const prompt = this.getNightPrompt(id);
        if (cognition && prompt) {
          void cognition.addMemory({
            id: crypto.randomUUID(),
            agentId: id,
            type: 'observation',
            content: prompt,
            importance: 9,
            timestamp: Date.now(),
            relatedAgentIds: [],
          }).catch(() => {});
        }
      }
    }

    // Start wolf private conversation
    const wolfIds = getWolfIds(this.state.roles).filter(id => this.state.alive.has(id));
    if (wolfIds.length >= 2) {
      const wolfAgent = this.world.getAgent(wolfIds[0]);
      if (wolfAgent) {
        const convId = this.conversationManager.startConversation(
          wolfIds,
          undefined,
          { ...wolfAgent.position },
          'werewolf_night_hunt',
        );
        this.state.wolfConversationId = convId;
        for (const wid of wolfIds) {
          const ctrl = this.controllers.get(wid);
          if (ctrl) ctrl.enterConversation();
        }
      }
    }

    console.log(`[Werewolf] Night ${this.state.round} begins`);
  }

  private resolveNight(): void {
    const { wolfTarget, healerGuard } = this.state.nightActions;
    const result: NightResult = {
      killed: null,
      saved: false,
      investigation: null,
    };

    // Resolve wolf attack
    const wolfIds = getWolfIds(this.state.roles).filter(id => this.state.alive.has(id));
    if (wolfTarget) {
      // Broadcast wolf target for god-mode sidebar
      for (const wid of wolfIds) {
        this.broadcaster.werewolfNightAction('wolfTarget', wid, wolfTarget);
      }

      if (wolfTarget === healerGuard) {
        // Attack blocked by healer
        result.saved = true;
        this.broadcaster.werewolfKill(wolfTarget, true);

        // Event log: healer save
        const healerEntry = [...this.state.roles.entries()].find(([id, r]) => r === 'healer' && this.state.alive.has(id));
        if (healerEntry) {
          this.state.eventLog.push({
            day: this.state.round,
            phase: 'night',
            event: `${this.agentNames.get(healerEntry[0])} saved ${this.agentNames.get(wolfTarget)} from attack`,
            agentIds: [healerEntry[0], wolfTarget],
          });
        }

        // Notify wolves their attack was blocked (no mutual identification)
        for (const wid of wolfIds) {
          const wolfCognition = this.cognitions.get(wid);
          if (wolfCognition) {
            void wolfCognition.addMemory({
              id: crypto.randomUUID(),
              agentId: wid,
              type: 'observation',
              content: `Night ${this.state.round}: Your attack on ${this.agentNames.get(wolfTarget)} was blocked. Someone was guarding them.`,
              importance: 9,
              isCore: true,
              keywords: ['attack', 'blocked', 'healer', 'night', 'strategy'],
              timestamp: Date.now(),
              relatedAgentIds: [wolfTarget],
            }).catch(() => {});
          }
        }

        console.log(`[Werewolf] Healer saved ${this.agentNames.get(wolfTarget)}!`);
      } else {
        // Kill target
        result.killed = wolfTarget;
        this.state.alive.delete(wolfTarget);
        this.state.dead.push(wolfTarget);

        const agent = this.world.getAgent(wolfTarget);
        if (agent) {
          agent.alive = false;
          agent.state = 'dead';
          this.world.updateAgentState(wolfTarget, 'dead', 'dead');
        }

        this.broadcaster.werewolfKill(wolfTarget, false);
        this.broadcaster.agentDeath(wolfTarget, 'werewolf attack');

        // Event log: wolf kill
        const wolfNames = wolfIds.map(id => this.agentNames.get(id) ?? id);
        this.state.eventLog.push({
          day: this.state.round,
          phase: 'night',
          event: `${wolfNames.join(' and ')} eliminated ${this.agentNames.get(wolfTarget)}`,
          agentIds: [...wolfIds, wolfTarget],
        });

        console.log(`[Werewolf] ${this.agentNames.get(wolfTarget)} was killed by werewolves`);
      }
    }

    // Store sheriff investigation in result (already stored in state.investigations in recordNightAction)
    if (this.state.nightActions.sheriffTarget) {
      const targetRole = this.state.roles.get(this.state.nightActions.sheriffTarget);
      result.investigation = {
        targetId: this.state.nightActions.sheriffTarget,
        targetName: this.agentNames.get(this.state.nightActions.sheriffTarget) ?? '',
        isWolf: targetRole === 'werewolf',
      };
    }

    // Update lastGuarded for healer
    this.state.lastGuarded = this.state.nightActions.healerGuard;

    // Broadcast healer guard for god-mode sidebar
    if (this.state.nightActions.healerGuard) {
      const healerId = [...this.state.roles.entries()].find(([id, r]) => r === 'healer' && this.state.alive.has(id))?.[0];
      if (healerId) {
        this.broadcaster.werewolfNightAction('healerGuard', healerId, this.state.nightActions.healerGuard);
      }
    }

    // Broadcast sheriff investigation for god-mode sidebar
    if (this.state.nightActions.sheriffTarget) {
      const sheriffId = [...this.state.roles.entries()].find(([id, r]) => r === 'sheriff' && this.state.alive.has(id))?.[0];
      const targetRole = this.state.roles.get(this.state.nightActions.sheriffTarget);
      if (sheriffId) {
        this.broadcaster.werewolfNightAction('sheriffResult', sheriffId, this.state.nightActions.sheriffTarget, targetRole === 'werewolf' ? 'werewolf' : 'innocent');
      }
    }

    this.state.lastNightResult = result;
  }

  private transitionToDawn(): void {
    this.state.phase = 'dawn';
    this.state.phaseTimer = 0;
    this.broadcaster.werewolfPhase('dawn', this.state.round);

    // Check win after night kill
    const winner = this.checkWin();
    if (winner) {
      this.endGame(winner);
      return;
    }

    // Dawn announcement memory for all living agents
    const announcement = buildDawnAnnouncement(this.state.lastNightResult!, this.agentNames);
    for (const id of this.state.alive) {
      const cognition = this.cognitions.get(id);
      if (!cognition) continue;
      void cognition.addMemory({
        id: crypto.randomUUID(),
        agentId: id,
        type: 'observation',
        content: `Dawn of day ${this.state.round}. ${announcement}`,
        importance: 9,
        isCore: true,
        keywords: ['death', 'kill', 'night', 'dawn', 'werewolf'],
        timestamp: Date.now(),
        relatedAgentIds: this.state.lastNightResult?.killed ? [this.state.lastNightResult.killed] : [],
      }).catch(() => {});
    }

    console.log(`[Werewolf] Dawn: ${announcement}`);
  }

  private transitionToDay(): void {
    this.state.phase = 'day';
    this.state.phaseTimer = 0;
    this.state.voteCalled = false;
    this.broadcaster.werewolfPhase('day', this.state.round);

    // Wake all living agents
    for (const id of this.state.alive) {
      this.world.updateAgentState(id, 'active', '');
      const ctrl = this.controllers.get(id);
      if (ctrl && ctrl.state === 'sleeping') {
        ctrl.state = 'idle';
      }

      // Inject day prompt
      const cognition = this.cognitions.get(id);
      if (cognition) {
        const dayPrompt = this.getDayPrompt();
        void cognition.addMemory({
          id: crypto.randomUUID(),
          agentId: id,
          type: 'observation',
          content: dayPrompt,
          importance: 8,
          timestamp: Date.now(),
          relatedAgentIds: [],
        }).catch(() => {});
      }
    }

    console.log(`[Werewolf] Day ${this.state.round} begins`);
  }

  private advanceToNextNight(): void {
    // Compress timeline noise before next round — keeps deaths/votes, merges accusations
    for (const id of this.state.alive) {
      const cognition = this.cognitions.get(id);
      if (cognition?.fourStream) {
        cognition.fourStream.compressWerewolfTimeline();
      }
    }

    this.state.round++;
    this.state.phase = 'night';
    this.state.phaseTimer = 0;
    this.broadcaster.werewolfPhase('night', this.state.round);
    this.transitionToNight();
  }

  private transitionToMeeting(): void {
    this.state.phase = 'meeting';
    this.state.phaseTimer = 0;
    this.state.voteCalled = false;
    this.meetingTranscript = [];
    this.broadcaster.werewolfPhase('meeting', this.state.round);

    // Start capturing all speech during the meeting (filter to meeting conversation only)
    this.broadcaster.setOnSpeakHook((_agentId, name, message, conversationId) => {
      // Only capture speech from the meeting conversation (not side conversations)
      if (this.state.meetingConversationId && conversationId !== this.state.meetingConversationId) return;
      this.meetingTranscript.push({ name, message });
      console.log(`[MeetingTranscript] ${name}: "${message.substring(0, 60)}${message.length > 60 ? '...' : ''}" (${this.meetingTranscript.length} lines total)`);
    });

    // Inject meeting prompt to all alive agents
    for (const id of this.state.alive) {
      const cognition = this.cognitions.get(id);
      if (!cognition) continue;
      void cognition.addMemory({
        id: crypto.randomUUID(),
        agentId: id,
        type: 'observation',
        content: this.buildMeetingPrompt(),
        importance: 10,
        timestamp: Date.now(),
        relatedAgentIds: [],
      }).catch(() => {});
    }

    // Walk all alive agents toward the campfire in a ring
    const aliveIds = [...this.state.alive];
    const campX = 15, campY = 15;
    aliveIds.forEach((id, i) => {
      const angle = (i / aliveIds.length) * Math.PI * 2;
      const radius = 3;
      const tx = Math.round(campX + Math.cos(angle) * radius);
      const ty = Math.round(campY + Math.sin(angle) * radius);
      const ctrl = this.controllers.get(id);
      if (ctrl) ctrl.startMoveTo({ x: tx, y: ty });
    });

    // Start a forced group conversation with ALL alive agents at campfire
    if (aliveIds.length >= 2) {
      const meetingLoc = { x: campX, y: campY };
      const convId = this.conversationManager.startConversation(
        aliveIds,
        undefined,
        meetingLoc,
        'werewolf_town_meeting',
      );
      this.state.meetingConversationId = convId;
      // Put all alive agents into conversing state
      for (const id of aliveIds) {
        const ctrl = this.controllers.get(id);
        if (ctrl) ctrl.enterConversation();
      }
    }

    // Event log
    this.state.eventLog.push({
      day: this.state.round,
      phase: 'day',
      event: 'Town meeting called at the campfire',
      agentIds: [],
    });

    console.log(`[Werewolf] Town Meeting begins (Round ${this.state.round}) — ${aliveIds.length} agents in group conversation`);
  }

  private transitionToAfternoon(): void {
    this.broadcaster.setOnSpeakHook(undefined);
    this.state.phase = 'day';
    this.state.phaseTimer = 0;
    this.state.voteCalled = false;
    this.broadcaster.werewolfPhase('day', this.state.round);

    // Scatter agents away from campfire after meeting
    const campX = 15, campY = 15;
    const aliveIds = [...this.state.alive];
    aliveIds.forEach((id, i) => {
      const angle = (i / aliveIds.length) * Math.PI * 2;
      const radius = 5 + Math.floor(Math.random() * 3);
      const tx = Math.round(campX + Math.cos(angle) * radius);
      const ty = Math.round(campY + Math.sin(angle) * radius);
      const ctrl = this.controllers.get(id);
      if (ctrl) ctrl.startMoveTo({ x: tx, y: ty });
    });

    console.log(`[Werewolf] Afternoon — free time until nightfall`);
  }

  private buildMeetingPrompt(): string {
    const aliveNames = [...this.state.alive].map(id => this.agentNames.get(id) ?? id);
    const deadNames = this.state.dead.map(id => this.agentNames.get(id) ?? id);
    const lastNight = this.state.lastNightResult;
    let dawnLine = '';
    if (lastNight?.killed) {
      dawnLine = `Last night: ${this.agentNames.get(lastNight.killed) ?? 'someone'} was found dead.`;
    } else {
      dawnLine = 'Last night: Everyone survived.';
    }

    const urgency = this.state.round > 5
      ? '\n\nURGENT: The village grows desperate. People are dying every night. You MUST find the werewolves soon.'
      : '';

    return `TOWN MEETING — Day ${this.state.round}. ${dawnLine}
The bell rings at noon. Everyone gathers at the plaza for the daily meeting.

Alive (${aliveNames.length}): ${aliveNames.join(', ')}
Dead: ${deadNames.length > 0 ? deadNames.join(', ') : 'none'}

This is the time to discuss suspicions, share evidence, and form opinions.
At the end of the meeting, everyone will vote on who to exile.

MEETING ACTIONS:
- talk [name] — discuss with someone
- accuse [name] — publicly accuse
- defend — defend yourself
- share_info — share evidence
- reveal_role — reveal your role
- observe — watch reactions
- think — reflect on evidence${urgency}`;
  }

  /** Handle vote result — announce and schedule exile or no-exile */
  private handleVoteResult(): void {
    const result = this.voteManager.getResult();
    if (result.exiledId) {
      this.state.pendingExileId = result.exiledId;
      const name = this.agentNames.get(result.exiledId) ?? 'someone';
      const role = this.state.roles.get(result.exiledId) ?? 'villager';
      this.broadcaster.werewolfVote(result.exiledId, role);
      // Memory: condemned but execution at dusk
      for (const id of this.state.alive) {
        const cognition = this.cognitions.get(id);
        if (!cognition) continue;
        void cognition.addMemory({
          id: crypto.randomUUID(),
          agentId: id,
          type: 'observation',
          content: `The vote has concluded: ${name} is condemned. They will be executed at dusk (17:00).`,
          importance: 10,
          isCore: true,
          keywords: ['vote', 'exile', 'condemned', name.split(' ')[0].toLowerCase()],
          timestamp: Date.now(),
          relatedAgentIds: [result.exiledId],
        }).catch(() => {});
      }
      console.log(`[Werewolf] ${name} condemned — execution scheduled for 17:00`);
    } else {
      this.broadcaster.werewolfVote(null, null);
      // Memory: no exile
      for (const id of this.state.alive) {
        const cognition = this.cognitions.get(id);
        if (!cognition) continue;
        void cognition.addMemory({
          id: crypto.randomUUID(),
          agentId: id,
          type: 'observation',
          content: `The vote has concluded: no one was exiled. The votes were tied or insufficient.`,
          importance: 8,
          timestamp: Date.now(),
          relatedAgentIds: [],
        }).catch(() => {});
      }
      console.log(`[Werewolf] No one exiled — tied or insufficient votes`);
    }
    this.transitionToAfternoon();
  }

  private allNightActionsComplete(): boolean {
    const { wolfTargetConfirmed, sheriffDone, healerDone } = this.state.nightActions;

    // Check if sheriff/healer are still alive
    const sheriffAlive = [...this.state.roles.entries()].some(([id, r]) => r === 'sheriff' && this.state.alive.has(id));
    const healerAlive = [...this.state.roles.entries()].some(([id, r]) => r === 'healer' && this.state.alive.has(id));

    const sheriffComplete = !sheriffAlive || sheriffDone;
    const healerComplete = !healerAlive || healerDone;

    return wolfTargetConfirmed && sheriffComplete && healerComplete;
  }

  // -----------------------------------------------------------------------
  // Win condition (from plan doc)
  // -----------------------------------------------------------------------

  checkWin(): 'villagers' | 'werewolves' | null {
    const wolves = [...this.state.alive].filter(id => this.state.roles.get(id) === 'werewolf');
    const others = [...this.state.alive].filter(id => this.state.roles.get(id) !== 'werewolf');

    if (wolves.length === 0) return 'villagers';
    if (wolves.length >= others.length) return 'werewolves';
    return null;
  }

  // -----------------------------------------------------------------------
  // Exile + Game End
  // -----------------------------------------------------------------------

  private exileAgent(agentId: string): void {
    this.state.alive.delete(agentId);
    this.state.exiled.push(agentId);

    const agent = this.world.getAgent(agentId);
    if (agent) {
      agent.alive = false;
      agent.state = 'dead';
      this.world.updateAgentState(agentId, 'dead', 'exiled');
    }

    const role = this.state.roles.get(agentId) ?? 'villager';
    this.broadcaster.werewolfVote(agentId, role);
    this.broadcaster.werewolfReveal(agentId, role);
    this.broadcaster.agentDeath(agentId, 'exiled by vote');

    // Memory for all living agents
    const name = this.agentNames.get(agentId) ?? 'someone';
    for (const id of this.state.alive) {
      const cognition = this.cognitions.get(id);
      if (!cognition) continue;
      void cognition.addMemory({
        id: crypto.randomUUID(),
        agentId: id,
        type: 'observation',
        content: `${name} was exiled. Their role was revealed: ${role.toUpperCase()}.`,
        importance: 10,
        isCore: true,
        keywords: ['exile', 'role', 'reveal', role.toLowerCase(), name.split(' ')[0].toLowerCase()],
        timestamp: Date.now(),
        relatedAgentIds: [agentId],
      }).catch(() => {});
    }

    // Event log: exile
    this.state.eventLog.push({
      day: this.state.round,
      phase: 'vote',
      event: `Village exiled ${name} (${role})`,
      agentIds: [agentId],
    });

    console.log(`[Werewolf] ${name} exiled — was ${role}`);
  }

  private endGame(winner: 'villagers' | 'werewolves'): void {
    this.state.phase = 'ended';
    this.state.winner = winner;

    // Reveal all roles
    for (const [id, role] of this.state.roles) {
      this.broadcaster.werewolfReveal(id, role);
    }

    this.broadcaster.werewolfEnd(winner);

    // Build and broadcast full game over payload
    const roles = [...this.state.roles.entries()].map(([id, role]) => ({
      agentId: id,
      name: this.agentNames.get(id) ?? id,
      role: role as 'werewolf' | 'sheriff' | 'healer' | 'villager',
      alive: this.state.alive.has(id),
    }));

    const stats = {
      totalDays: this.state.round,
      totalKills: this.state.eventLog.filter(e => e.event.includes('eliminated')).length,
      healerSaves: this.state.eventLog.filter(e => e.event.includes('saved')).length,
      correctExiles: this.state.eventLog.filter(e => e.event.includes('exiled') && e.event.includes('werewolf')).length,
      wrongExiles: this.state.eventLog.filter(e => e.event.includes('exiled') && !e.event.includes('werewolf')).length,
    };

    this.broadcaster.werewolfGameOver({
      winner,
      roles,
      timeline: this.state.eventLog,
      stats,
    });

    console.log(`[Werewolf] GAME OVER — ${winner} win!`);
  }
}
