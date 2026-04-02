import type { AgentCognition } from '@ai-village/ai-engine';
import type { World } from '../world.js';
import type { EventBroadcaster } from '../events.js';
import type { AgentController } from '../agent-controller.js';
import type { WerewolfGameState } from './types.js';

// ---------------------------------------------------------------------------
// WerewolfVoteManager — handles the call_vote → speeches → vote → exile flow
// ---------------------------------------------------------------------------

export class WerewolfVoteManager {
  private callerId: string | null = null;
  private nomineeId: string | null = null;
  private votes: Map<string, 'exile' | 'save'> = new Map();
  private resolved: boolean = false;
  private result: { exiled: string | null; roleRevealed: string | null } = { exiled: null, roleRevealed: null };
  /** Track which agents have spoken during pre-vote discussion */
  private spokeDuringVote: Set<string> = new Set();

  constructor(
    private state: WerewolfGameState,
    private broadcaster: EventBroadcaster,
    private world: World,
    private controllers: Map<string, AgentController>,
    private cognitions: Map<string, AgentCognition>,
  ) {}

  startVote(callerId: string, nomineeId: string): void {
    this.callerId = callerId;
    this.nomineeId = nomineeId;
    this.votes.clear();
    this.resolved = false;
    this.result = { exiled: null, roleRevealed: null };
    this.spokeDuringVote.clear();

    const callerName = this.world.getAgent(callerId)?.config.name ?? 'Someone';
    const nomineeName = this.world.getAgent(nomineeId)?.config.name ?? 'someone';

    // Memory for all living agents: vote called
    for (const id of this.state.alive) {
      const cognition = this.cognitions.get(id);
      if (!cognition) continue;
      void cognition.addMemory({
        id: crypto.randomUUID(),
        agentId: id,
        type: 'observation',
        content: `The bell rings! ${callerName} calls for a vote to exile ${nomineeName}. Everyone walks to the plaza.`,
        importance: 9,
        timestamp: Date.now(),
        relatedAgentIds: [callerId, nomineeId],
      }).catch(() => {});
    }

    console.log(`[WerewolfVote] ${callerName} calls vote against ${nomineeName}`);
  }

  recordVote(voterId: string, vote: 'exile' | 'save'): void {
    if (this.resolved) return;
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
    const aliveCount = this.state.alive.size;
    if (this.votes.size >= aliveCount) {
      this.resolve();
    }
  }

  tick(): void {
    // Vote resolution happens when all votes are in or on timeout
  }

  isComplete(): boolean {
    return this.resolved;
  }

  getResult(): { exiled: string | null; roleRevealed: string | null } {
    return this.result;
  }

  private resolve(): void {
    if (this.resolved) return;
    this.resolved = true;

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

      // Record in state voting history
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
