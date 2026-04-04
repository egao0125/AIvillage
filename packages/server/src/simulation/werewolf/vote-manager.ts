import type { AgentCognition } from '@ai-village/ai-engine';
import type { World } from '../world.js';
import type { EventBroadcaster } from '../events.js';
import type { AgentController } from '../agent-controller.js';
import type { WerewolfGameState } from './types.js';

// ---------------------------------------------------------------------------
// WerewolfVoteManager — free plurality vote:
// gathering (10 ticks) → discussion (20 ticks) → voting → resolve
// ---------------------------------------------------------------------------

type VoteSubPhase = 'gathering' | 'discussion' | 'voting' | 'resolved';

const GATHERING_TICKS = 10;
const DISCUSSION_TICKS = 20;

export class WerewolfVoteManager {
  /** voterId → targetId (who they want to exile) */
  private votes: Map<string, string> = new Map();
  private resolved: boolean = false;
  private result: { exiledId: string | null; roleRevealed: string | null } = { exiledId: null, roleRevealed: null };
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

  startVote(meetingTranscript?: Array<{ name: string; message: string }>): void {
    this.meetingTranscript = meetingTranscript ?? [];
    this.votes.clear();
    this.resolved = false;
    this.result = { exiledId: null, roleRevealed: null };
    this.votePhase = 'gathering';
    this.votePhaseTimer = 0;

    // Memory for all living agents: system announces vote
    for (const id of this.state.alive) {
      const cognition = this.cognitions.get(id);
      if (!cognition) continue;
      void cognition.addMemory({
        id: crypto.randomUUID(),
        agentId: id,
        type: 'observation',
        content: `The bell rings! The village must now vote. Each person will name one person they want to exile. The person with the most votes will be exiled.`,
        importance: 9,
        timestamp: Date.now(),
        relatedAgentIds: [],
      }).catch(() => {});
    }

    console.log(`[WerewolfVote] System-initiated vote — gathering phase`);
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
          // Force-interrupt all alive agents so they vote immediately
          for (const id of this.state.alive) {
            const ctrl = this.controllers.get(id);
            if (ctrl) ctrl.interruptForVote();
          }
        }
        break;

      case 'voting':
        // Votes collected via recordVote(); auto-resolves when all in
        break;
    }
  }

  recordVote(voterId: string, targetId: string): void {
    if (this.resolved) return;
    // Accept votes during any sub-phase (agents decide asynchronously via LLM)
    if (!this.state.alive.has(voterId)) return;

    // Skip duplicate votes from the same agent
    if (this.votes.has(voterId)) return;

    // Validate target is alive
    if (!this.state.alive.has(targetId)) {
      const targetName = this.world.getAgent(targetId)?.config.name ?? 'that person';
      console.log(`[WerewolfVote] ${this.world.getAgent(voterId)?.config.name} tried to vote for dead ${targetName} — rejected`);
      const cognition = this.cognitions.get(voterId);
      if (cognition) {
        void cognition.addMemory({
          id: crypto.randomUUID(),
          agentId: voterId,
          type: 'observation',
          content: `${targetName} is already dead. Choose a living person to vote for.`,
          importance: 9,
          timestamp: Date.now(),
          relatedAgentIds: [],
        }).catch(() => {});
      }
      return;
    }

    this.votes.set(voterId, targetId);

    // Update agent's voting history
    const agent = this.world.getAgent(voterId);
    const targetAgent = this.world.getAgent(targetId);
    if (agent) {
      if (!agent.votingHistory) agent.votingHistory = [];
      agent.votingHistory.push({
        day: this.state.round,
        targetId,
        targetName: targetAgent?.config.name ?? targetId,
      });
    }

    const voterName = agent?.config.name ?? voterId;
    const targetName = targetAgent?.config.name ?? targetId;
    console.log(`[WerewolfVote] ${voterName} votes to exile ${targetName} (${this.votes.size}/${this.state.alive.size})`);

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

  getResult(): { exiledId: string | null; roleRevealed: string | null } {
    return this.result;
  }

  // -----------------------------------------------------------------------
  // Private — Phase transitions
  // -----------------------------------------------------------------------

  private injectDiscussionMemories(): void {
    // Build meeting transcript block (everything said during the meeting before the vote)
    let transcriptBlock = '';
    if (this.meetingTranscript.length > 0) {
      const lines = this.meetingTranscript.map(t => `  ${t.name}: "${t.message}"`);
      transcriptBlock = `\n\nMEETING TRANSCRIPT (what was said today):\n${lines.join('\n')}`;
    }

    // Build alive agents list
    const aliveList = [...this.state.alive].map(id => {
      const name = this.world.getAgent(id)?.config.name ?? id;
      return `- ${name}`;
    }).join('\n');

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

      const content = `VOTE DISCUSSION — The village must decide who to exile today.\n\nALIVE VILLAGERS:\n${aliveList}\n\nDiscuss your suspicions. Think about what you've observed and heard.${transcriptBlock}${privateKnowledge}`;

      void cognition.addMemory({
        id: crypto.randomUUID(),
        agentId: id,
        type: 'observation',
        content,
        importance: 9,
        timestamp: Date.now(),
        relatedAgentIds: [],
      }).catch(() => {});
    }

    console.log(`[WerewolfVote] Discussion phase — transcript (${this.meetingTranscript.length} lines) injected`);
  }

  private injectVotePrompt(): void {
    // Build alive agents list
    const aliveList = [...this.state.alive].map(id => {
      const name = this.world.getAgent(id)?.config.name ?? id;
      return `- ${name}`;
    }).join('\n');

    for (const id of this.state.alive) {
      const cognition = this.cognitions.get(id);
      if (!cognition) continue;

      // Build private reminder
      const role = this.state.roles.get(id);
      const agent = this.world.getAgent(id);
      let reminder = '';

      if (role === 'sheriff' && agent?.investigations?.length) {
        const wolfFindings = agent.investigations.filter((inv: { result: string }) => inv.result === 'werewolf');
        if (wolfFindings.length > 0) {
          reminder = '\nREMINDER: Your investigations found: ' +
            wolfFindings.map((inv: { targetName: string }) => `${inv.targetName} is a WEREWOLF`).join(', ') + '.';
        }
      } else if (role === 'werewolf') {
        // Warn wolf about voting for fellow wolf
        const fellowWolfIds = [...this.state.roles.entries()]
          .filter(([wid, r]) => r === 'werewolf' && wid !== id && this.state.alive.has(wid))
          .map(([wid]) => this.world.getAgent(wid)?.config.name ?? wid);
        if (fellowWolfIds.length > 0) {
          reminder = `\nWARNING: ${fellowWolfIds.join(', ')} ${fellowWolfIds.length === 1 ? 'is' : 'are'} your fellow wolf(s). Do NOT vote for them. Target a villager instead.`;
        }
      }

      void cognition.addMemory({
        id: crypto.randomUUID(),
        agentId: id,
        type: 'observation',
        content: `CAST YOUR VOTE NOW. Name ONE person to exile.\n\nALIVE VILLAGERS:\n${aliveList}\n\nUse: vote [name]\nState your vote and a one-sentence reason.${reminder}`,
        importance: 10,
        timestamp: Date.now(),
        relatedAgentIds: [],
      }).catch(() => {});
    }

    console.log(`[WerewolfVote] Voting phase — vote prompts injected`);
  }

  private resolve(): void {
    if (this.resolved) return;
    this.resolved = true;
    this.votePhase = 'resolved';

    // Tally votes per target
    const tally: Map<string, number> = new Map();
    for (const targetId of this.votes.values()) {
      tally.set(targetId, (tally.get(targetId) ?? 0) + 1);
    }

    // Find plurality winner (strict — no ties)
    let maxVotes = 0;
    let winnerId: string | null = null;
    let isTied = false;

    for (const [targetId, count] of tally) {
      if (count > maxVotes) {
        maxVotes = count;
        winnerId = targetId;
        isTied = false;
      } else if (count === maxVotes) {
        isTied = true;
      }
    }

    // Tie = no exile
    if (isTied || !winnerId || maxVotes === 0) {
      this.result = { exiledId: null, roleRevealed: null };

      this.state.votingHistory.push({
        day: this.state.round,
        votes: new Map(this.votes),
        result: 'no_exile',
        exiledId: null,
        roleRevealed: null,
      });
    } else {
      const role = this.state.roles.get(winnerId) ?? 'villager';
      this.result = { exiledId: winnerId, roleRevealed: role };

      this.state.votingHistory.push({
        day: this.state.round,
        votes: new Map(this.votes),
        result: 'exiled',
        exiledId: winnerId,
        roleRevealed: role,
      });
    }

    // Broadcast detailed vote results for sidebar
    const votesObj: Record<string, string> = {};
    for (const [id, target] of this.votes) {
      votesObj[id] = target;
    }
    this.broadcaster.werewolfVoteDetail(
      this.state.round,
      votesObj,
      this.result.exiledId ? 'exiled' : 'no_exile',
      this.result.exiledId,
    );

    // Log result
    if (this.result.exiledId) {
      const name = this.world.getAgent(this.result.exiledId)?.config.name ?? 'someone';
      console.log(`[WerewolfVote] Result: ${name} EXILED (${maxVotes} votes) — ${[...tally.entries()].map(([id, c]) => `${this.world.getAgent(id)?.config.name}: ${c}`).join(', ')}`);
    } else {
      console.log(`[WerewolfVote] Result: NO EXILE (tied or no votes) — ${[...tally.entries()].map(([id, c]) => `${this.world.getAgent(id)?.config.name}: ${c}`).join(', ')}`);
    }
  }
}
