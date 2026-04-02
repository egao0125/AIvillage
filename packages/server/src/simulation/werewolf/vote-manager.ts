import type { AgentCognition } from '@ai-village/ai-engine';
import type { World } from '../world.js';
import type { EventBroadcaster } from '../events.js';
import type { AgentController } from '../agent-controller.js';
import type { WerewolfGameState } from './types.js';

// ---------------------------------------------------------------------------
// WerewolfVoteManager — structured vote flow:
// gathering (10 ticks) → discussion (20 ticks) → voting → resolve
// ---------------------------------------------------------------------------

type VoteSubPhase = 'gathering' | 'discussion' | 'voting' | 'resolved';

const GATHERING_TICKS = 10;
const DISCUSSION_TICKS = 20;

export class WerewolfVoteManager {
  private callerId: string | null = null;
  private nomineeId: string | null = null;
  private reason: string = '';
  private votes: Map<string, 'exile' | 'save'> = new Map();
  private resolved: boolean = false;
  private result: { exiled: string | null; roleRevealed: string | null } = { exiled: null, roleRevealed: null };
  private votePhase: VoteSubPhase = 'resolved';
  private votePhaseTimer: number = 0;

  constructor(
    private state: WerewolfGameState,
    private broadcaster: EventBroadcaster,
    private world: World,
    private controllers: Map<string, AgentController>,
    private cognitions: Map<string, AgentCognition>,
  ) {}

  startVote(callerId: string, nomineeId: string, reason?: string): void {
    this.callerId = callerId;
    this.nomineeId = nomineeId;
    this.reason = reason ?? '';
    this.votes.clear();
    this.resolved = false;
    this.result = { exiled: null, roleRevealed: null };
    this.votePhase = 'gathering';
    this.votePhaseTimer = 0;

    const callerName = this.world.getAgent(callerId)?.config.name ?? 'Someone';
    const nomineeName = this.world.getAgent(nomineeId)?.config.name ?? 'someone';

    // Memory for all living agents: vote called, everyone moves to plaza
    for (const id of this.state.alive) {
      const cognition = this.cognitions.get(id);
      if (!cognition) continue;
      void cognition.addMemory({
        id: crypto.randomUUID(),
        agentId: id,
        type: 'observation',
        content: `The bell rings! ${callerName} calls for a vote to exile ${nomineeName}. Everyone gathers at the plaza.`,
        importance: 9,
        timestamp: Date.now(),
        relatedAgentIds: [callerId, nomineeId],
      }).catch(() => {});
    }

    console.log(`[WerewolfVote] ${callerName} calls vote against ${nomineeName} — gathering phase`);
  }

  tick(): void {
    if (this.resolved) return;
    this.votePhaseTimer++;

    switch (this.votePhase) {
      case 'gathering':
        if (this.votePhaseTimer >= GATHERING_TICKS) {
          this.votePhase = 'discussion';
          this.votePhaseTimer = 0;
          this.injectDiscussionMemories();
        }
        break;

      case 'discussion':
        if (this.votePhaseTimer >= DISCUSSION_TICKS) {
          this.votePhase = 'voting';
          this.votePhaseTimer = 0;
          this.injectVotePrompt();
        }
        break;

      case 'voting':
        // Votes collected via recordVote(); auto-resolves when all in
        break;
    }
  }

  recordVote(voterId: string, vote: 'exile' | 'save'): void {
    if (this.resolved) return;
    if (this.votePhase !== 'voting') return; // only accept during voting phase
    if (!this.state.alive.has(voterId)) return;
    this.votes.set(voterId, vote);

    // Update agent's voting history
    const agent = this.world.getAgent(voterId);
    if (agent && this.nomineeId) {
      if (!agent.votingHistory) agent.votingHistory = [];
      agent.votingHistory.push({
        day: this.state.round,
        nomineeId: this.nomineeId,
        vote,
      });
    }

    // Check if all alive agents have voted
    if (this.votes.size >= this.state.alive.size) {
      this.resolve();
    }
  }

  isComplete(): boolean {
    return this.resolved;
  }

  getResult(): { exiled: string | null; roleRevealed: string | null } {
    return this.result;
  }

  // -----------------------------------------------------------------------
  // Private — Phase transitions
  // -----------------------------------------------------------------------

  private injectDiscussionMemories(): void {
    const callerName = this.callerId ? (this.world.getAgent(this.callerId)?.config.name ?? 'Someone') : 'Someone';
    const nomineeName = this.nomineeId ? (this.world.getAgent(this.nomineeId)?.config.name ?? 'someone') : 'someone';
    const accusation = this.reason
      ? `${callerName} accuses ${nomineeName}: "${this.reason}"`
      : `${callerName} accuses ${nomineeName} of being a werewolf.`;

    for (const id of this.state.alive) {
      const cognition = this.cognitions.get(id);
      if (!cognition) continue;

      let content: string;
      if (id === this.callerId) {
        content = `You stand before the crowd. State your case against ${nomineeName}. ${accusation}`;
      } else if (id === this.nomineeId) {
        content = `You are accused! ${accusation}\nThis is your chance to defend yourself. Convince the village you are innocent.`;
      } else {
        content = `The debate begins. ${accusation}\nDo you support this accusation or oppose it? Speak up before the vote.`;
      }

      void cognition.addMemory({
        id: crypto.randomUUID(),
        agentId: id,
        type: 'observation',
        content,
        importance: 9,
        timestamp: Date.now(),
        relatedAgentIds: [this.callerId!, this.nomineeId!].filter(Boolean),
      }).catch(() => {});
    }

    console.log(`[WerewolfVote] Discussion phase — speeches injected`);
  }

  private injectVotePrompt(): void {
    const nomineeName = this.nomineeId ? (this.world.getAgent(this.nomineeId)?.config.name ?? 'someone') : 'someone';

    for (const id of this.state.alive) {
      const cognition = this.cognitions.get(id);
      if (!cognition) continue;
      void cognition.addMemory({
        id: crypto.randomUUID(),
        agentId: id,
        type: 'observation',
        content: `The discussion is over. Cast your vote now: vote_exile ${nomineeName} or vote_save ${nomineeName}. State your vote and a one-sentence reason.`,
        importance: 10,
        timestamp: Date.now(),
        relatedAgentIds: this.nomineeId ? [this.nomineeId] : [],
      }).catch(() => {});
    }

    console.log(`[WerewolfVote] Voting phase — vote prompts injected`);
  }

  private resolve(): void {
    if (this.resolved) return;
    this.resolved = true;
    this.votePhase = 'resolved';

    let exileCount = 0;
    let saveCount = 0;
    for (const vote of this.votes.values()) {
      if (vote === 'exile') exileCount++;
      else saveCount++;
    }

    const majority = exileCount > saveCount;

    if (majority && this.nomineeId) {
      const role = this.state.roles.get(this.nomineeId) ?? 'villager';
      this.result = { exiled: this.nomineeId, roleRevealed: role };

      this.state.votingHistory.push({
        day: this.state.round,
        callerId: this.callerId!,
        nomineeId: this.nomineeId,
        votes: new Map(this.votes),
        result: 'exiled',
        roleRevealed: role,
      });
    } else {
      this.result = { exiled: null, roleRevealed: null };

      if (this.nomineeId) {
        this.state.votingHistory.push({
          day: this.state.round,
          callerId: this.callerId!,
          nomineeId: this.nomineeId,
          votes: new Map(this.votes),
          result: 'saved',
          roleRevealed: null,
        });
      }
    }

    const nomineeName = this.nomineeId ? (this.world.getAgent(this.nomineeId)?.config.name ?? 'someone') : 'no one';
    console.log(`[WerewolfVote] Result: ${exileCount} exile, ${saveCount} save → ${majority ? `${nomineeName} EXILED` : `${nomineeName} SAVED`}`);
  }
}
