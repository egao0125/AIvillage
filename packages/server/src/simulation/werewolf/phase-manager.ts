import type { Agent, GameTime, MapAction, Position } from '@ai-village/shared';
import type { EventBus } from '@ai-village/shared';
import type { AgentCognition } from '@ai-village/ai-engine';
import type { World } from '../world.js';
import type { EventBroadcaster } from '../events.js';
import type { AgentController } from '../agent-controller.js';
import type { ConversationManager } from '../conversation/index.js';
import type { WerewolfGameState, NightResult } from './types.js';
import { freshNightActions } from './types.js';
import { assignRoles, getWolfIds } from './role-assigner.js';
import {
  buildWerewolfRolePrompt,
  buildWolfNightPrompt,
  buildSheriffNightPrompt,
  buildHealerNightPrompt,
  buildDawnAnnouncement,
  buildDaySituationPrompt,
} from './prompts.js';
import { WerewolfVoteManager } from './vote-manager.js';

// ---------------------------------------------------------------------------
// Phase timing (ticks) — from plan doc
// ---------------------------------------------------------------------------
const NIGHT_TICKS = 60;
const DAWN_TICKS = 1;    // brief announcement
const DAY_TICKS = 200;
const VOTE_TICKS = 120;

// ---------------------------------------------------------------------------
// WerewolfPhaseManager — drives the entire werewolf game loop
// ---------------------------------------------------------------------------

export class WerewolfPhaseManager {
  private state: WerewolfGameState;
  private voteManager: WerewolfVoteManager;
  /** agentId → display name */
  private agentNames: Map<string, string> = new Map();

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

    // Inject role-specific system prompt into each agent's cognition
    for (const id of agentIds) {
      const cognition = this.cognitions.get(id);
      if (!cognition) continue;
      const rolePrompt = buildWerewolfRolePrompt(id, this.agentNames.get(id) ?? '', this.state, this.agentNames);
      void cognition.addMemory({
        id: crypto.randomUUID(),
        agentId: id,
        type: 'observation',
        content: rolePrompt,
        importance: 10,
        timestamp: Date.now(),
        relatedAgentIds: [],
      }).catch((err: unknown) => {
        console.warn(`[Werewolf] addMemory failed for ${id}:`, (err as Error).message);
      });
    }

    console.log(`[Werewolf] Game started with ${agentIds.length} agents. Roles: ${[...roles.entries()].map(([id, r]) => `${this.agentNames.get(id)}=${r}`).join(', ')}`);

    // Broadcast phase and start first night
    this.broadcaster.werewolfPhase('night', 1);
    this.state.phase = 'night';
    this.state.round = 1;
    this.state.phaseTimer = 0;
    this.transitionToNight();
  }

  /**
   * Called every engine tick when werewolf game is active.
   */
  onTick(_time: GameTime): void {
    if (this.state.phase === 'setup' || this.state.phase === 'ended') return;

    this.state.phaseTimer++;

    switch (this.state.phase) {
      case 'night':
        if (this.allNightActionsComplete() || this.state.phaseTimer >= NIGHT_TICKS) {
          this.resolveNight();
          this.transitionToDawn();
        }
        break;

      case 'dawn':
        if (this.state.phaseTimer >= DAWN_TICKS) {
          this.transitionToDay();
        }
        break;

      case 'day':
        if (this.state.phaseTimer >= DAY_TICKS) {
          // Day expired without a vote — go to night
          this.advanceToNextNight();
        }
        break;

      case 'vote':
        this.voteManager.tick();
        if (this.voteManager.isComplete()) {
          const result = this.voteManager.getResult();
          if (result.exiled) {
            this.exileAgent(result.exiled);
            const winner = this.checkWin();
            if (winner) {
              this.endGame(winner);
              return;
            }
          }
          this.advanceToNextNight();
        } else if (this.state.phaseTimer >= VOTE_TICKS) {
          // Vote timed out — no exile
          this.broadcaster.werewolfVote(null, null);
          this.advanceToNextNight();
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
          { id: 'follow', label: 'Follow someone', category: 'movement', requiresNearby: true },
          { id: 'rest', label: 'Rest / Wait', category: 'rest' },
        );
        if (!this.state.voteCalled) {
          actions.push({ id: 'call_vote', label: 'Call a vote', category: 'social' });
        }
        break;

      case 'vote':
        actions.push(
          { id: 'vote_exile', label: 'Vote to exile', category: 'social' },
          { id: 'vote_save', label: 'Vote to save', category: 'social' },
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

    switch (actionId) {
      case 'attack':
        if (role === 'werewolf') {
          this.state.nightActions.wolfTarget = targetId;
          this.state.nightActions.wolfTargetConfirmed = true;
          console.log(`[Werewolf] Wolf ${this.agentNames.get(agentId)} attacks ${this.agentNames.get(targetId)}`);
        }
        break;

      case 'change_target':
        if (role === 'werewolf') {
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
              timestamp: Date.now(),
              relatedAgentIds: [targetId],
            }).catch(() => {});
          }

          console.log(`[Werewolf] Sheriff investigates ${this.agentNames.get(targetId)} → ${isWolf ? 'WOLF' : 'clear'}`);
        }
        break;

      case 'guard':
        if (role === 'healer') {
          // Cannot guard same person as last night
          if (targetId === this.state.lastGuarded) {
            console.log(`[Werewolf] Healer tried to guard same person as last night — rejected`);
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
   * Handle call_vote during day phase.
   */
  callVote(callerId: string, nomineeId: string): void {
    if (this.state.phase !== 'day') return;
    if (this.state.voteCalled) return;
    if (!this.state.alive.has(callerId) || !this.state.alive.has(nomineeId)) return;

    this.state.voteCalled = true;
    this.state.phase = 'vote';
    this.state.phaseTimer = 0;
    this.broadcaster.werewolfPhase('vote', this.state.round);

    this.voteManager.startVote(callerId, nomineeId);

    console.log(`[Werewolf] ${this.agentNames.get(callerId)} calls vote against ${this.agentNames.get(nomineeId)}`);
  }

  /**
   * Record a vote during vote phase.
   */
  recordVote(voterId: string, vote: 'exile' | 'save'): void {
    if (this.state.phase !== 'vote') return;
    this.voteManager.recordVote(voterId, vote);
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
    };
  }

  private transitionToNight(): void {
    this.state.nightActions = freshNightActions();
    this.state.phaseTimer = 0;

    // Put villagers to sleep
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
    if (wolfTarget) {
      if (wolfTarget === healerGuard) {
        // Attack blocked by healer
        result.saved = true;
        this.broadcaster.werewolfKill(wolfTarget, true);
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
    this.state.round++;
    this.state.phase = 'night';
    this.state.phaseTimer = 0;
    this.broadcaster.werewolfPhase('night', this.state.round);
    this.transitionToNight();
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
        timestamp: Date.now(),
        relatedAgentIds: [agentId],
      }).catch(() => {});
    }

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

    console.log(`[Werewolf] GAME OVER — ${winner} win!`);
  }
}
