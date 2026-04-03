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
  /** Full meeting transcript — all speech that happened before the vote was called */
  private meetingTranscript: Array<{ name: string; message: string }> = [];

  constructor(
    private state: WerewolfGameState,
    private broadcaster: EventBroadcaster,
    private world: World,
    private controllers: Map<string, AgentController>,
    private cognitions: Map<string, AgentCognition>,
  ) {}

  startVote(callerId: string, nomineeId: string, reason?: string, meetingTranscript?: Array<{ name: string; message: string }>): void {
    this.callerId = callerId;
    this.nomineeId = nomineeId;
    this.reason = reason ?? '';
    this.meetingTranscript = meetingTranscript ?? [];
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
    // Accept votes during any sub-phase (agents decide asynchronously via LLM)
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

    const voterName = this.world.getAgent(voterId)?.config.name ?? voterId;
    console.log(`[WerewolfVote] ${voterName} votes ${vote} (${this.votes.size}/${this.state.alive.size})`);

    // Check if all alive agents have voted
    if (this.votes.size >= this.state.alive.size) {
      this.resolve();
    }
  }

  isComplete(): boolean {
    return this.resolved;
  }

  getVoteCount(): number {
    return this.votes.size;
  }

  /** Force resolve with whatever votes have been collected so far */
  forceResolve(): void {
    if (this.resolved) return;
    this.resolve();
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

    // Build meeting transcript block (everything said during the meeting before the vote)
    let transcriptBlock = '';
    if (this.meetingTranscript.length > 0) {
      const lines = this.meetingTranscript.map(t => `  ${t.name}: "${t.message}"`);
      transcriptBlock = `\n\nMEETING TRANSCRIPT (what was said today):\n${lines.join('\n')}`;
    }

    for (const id of this.state.alive) {
      const cognition = this.cognitions.get(id);
      if (!cognition) continue;

      // Build private knowledge for this agent
      let privateKnowledge = '';
      const agent = this.world.getAgent(id);
      const role = this.state.roles.get(id);

      if (role === 'sheriff' && agent?.investigations?.length) {
        privateKnowledge = '\n\nYOUR PRIVATE KNOWLEDGE (sheriff investigations):\n' +
          agent.investigations.map((inv: { night: number; targetName: string; result: string }) =>
            `  Night ${inv.night}: ${inv.targetName} — ${inv.result === 'werewolf' ? 'WEREWOLF!' : 'NOT a werewolf'}`
          ).join('\n');
      } else if (role === 'healer' && agent?.lastGuarded) {
        const guardedAgent = this.world.getAgent(agent.lastGuarded);
        privateKnowledge = `\n\nYOUR PRIVATE KNOWLEDGE: Last night you guarded ${guardedAgent?.config.name ?? 'someone'}.`;
      } else if (role === 'werewolf') {
        privateKnowledge = '\n\nREMEMBER: You are a werewolf pretending to be a villager. Vote strategically — protect yourself and your fellow wolf.';
      }

      let content: string;
      if (id === this.callerId) {
        content = `VOTE DISCUSSION — You called the vote against ${nomineeName}.\n${accusation}\nState your case to the village.${transcriptBlock}${privateKnowledge}`;
      } else if (id === this.nomineeId) {
        content = `VOTE DISCUSSION — You are accused!\n${accusation}\nThis is your chance to defend yourself. Convince the village you are innocent.${transcriptBlock}${privateKnowledge}`;
      } else {
        content = `VOTE DISCUSSION — ${accusation}\nListen to both sides. Think about what you've observed and heard.${transcriptBlock}${privateKnowledge}`;
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

    console.log(`[WerewolfVote] Discussion phase — speeches + transcript (${this.meetingTranscript.length} lines) injected`);
  }

  private injectVotePrompt(): void {
    const nomineeName = this.nomineeId ? (this.world.getAgent(this.nomineeId)?.config.name ?? 'someone') : 'someone';

    for (const id of this.state.alive) {
      const cognition = this.cognitions.get(id);
      if (!cognition) continue;

      // Remind agent of their private knowledge one more time before vote
      const role = this.state.roles.get(id);
      const agent = this.world.getAgent(id);
      let reminder = '';
      if (role === 'sheriff' && agent?.investigations?.length) {
        const relevant = agent.investigations.find((inv: { targetId: string }) => inv.targetId === this.nomineeId);
        if (relevant) {
          reminder = `\nREMINDER: Your investigation showed ${nomineeName} is ${(relevant as { result: string }).result === 'werewolf' ? 'a WEREWOLF!' : 'NOT a werewolf'}.`;
        }
      } else if (role === 'werewolf') {
        const nomineeRole = this.state.roles.get(this.nomineeId!);
        if (nomineeRole === 'werewolf') {
          reminder = '\nWARNING: The nominee is your fellow wolf! Vote to SAVE them.';
        } else {
          reminder = '\nThe nominee is not a wolf. Exiling them helps you win.';
        }
      }

      void cognition.addMemory({
        id: crypto.randomUUID(),
        agentId: id,
        type: 'observation',
        content: `CAST YOUR VOTE NOW. Should ${nomineeName} be exiled?\n\nUse vote_exile to exile ${nomineeName} or vote_save to spare them.\nState your vote and a one-sentence reason.${reminder}`,
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

    // Broadcast detailed vote results for sidebar
    const votesObj: Record<string, string> = {};
    for (const [id, v] of this.votes) {
      votesObj[id] = v;
    }
    this.broadcaster.werewolfVoteDetail(
      this.state.round,
      this.callerId!,
      this.nomineeId!,
      votesObj,
      majority ? 'exiled' : 'saved',
    );

    const nomineeName = this.nomineeId ? (this.world.getAgent(this.nomineeId)?.config.name ?? 'someone') : 'no one';
    console.log(`[WerewolfVote] Result: ${exileCount} exile, ${saveCount} save → ${majority ? `${nomineeName} EXILED` : `${nomineeName} SAVED`}`);
  }
}
