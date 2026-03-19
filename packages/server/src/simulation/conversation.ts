import type { BoardPostType, Conversation, Memory, Position } from '@ai-village/shared';
import type { AgentCognition } from '@ai-village/ai-engine';
import type { World } from './world.js';
import type { EventBroadcaster } from './events.js';

interface ActiveConversation {
  conversation: Conversation;
  turnCount: number;
  maxTurns: number;
  currentSpeakerIdx: number;
  processing: boolean;
}

export class ConversationManager {
  private activeConversations: Map<string, ActiveConversation> = new Map();

  constructor(
    private world: World,
    private broadcaster: EventBroadcaster,
  ) {}

  /**
   * Start a new conversation between two agents.
   * Returns the conversation ID.
   */
  startConversation(agent1Id: string, agent2Id: string, location: Position): string {
    const id = crypto.randomUUID();
    // Variable conversation length — some are a quick "hey" / "hey", others go deep
    // Weighted toward shorter: 40% short (2-4), 35% medium (5-8), 25% long (9-14)
    const roll = Math.random();
    const maxTurns = roll < 0.4
      ? 2 + Math.floor(Math.random() * 3)   // 2-4 turns
      : roll < 0.75
      ? 5 + Math.floor(Math.random() * 4)   // 5-8 turns
      : 9 + Math.floor(Math.random() * 6);  // 9-14 turns

    const conversation: Conversation = {
      id,
      participants: [agent1Id, agent2Id],
      messages: [],
      location: { ...location },
      startedAt: Date.now(),
    };

    this.world.addConversation(conversation);
    this.activeConversations.set(id, {
      conversation,
      turnCount: 0,
      maxTurns,
      currentSpeakerIdx: 0,
      processing: false,
    });

    const agent1 = this.world.getAgent(agent1Id);
    const agent2 = this.world.getAgent(agent2Id);
    console.log(
      `[Conversation] Started between ${agent1?.config.name ?? agent1Id} and ${agent2?.config.name ?? agent2Id} (max ${maxTurns} turns)`,
    );

    // Broadcast conversation start so client can draw visual link
    this.broadcaster.conversationStart(id, [agent1Id, agent2Id]);

    return id;
  }

  /**
   * Advance one turn in a conversation.
   * Returns false when the conversation is done.
   */
  async advanceTurn(
    conversationId: string,
    cognitions: Map<string, AgentCognition>,
  ): Promise<boolean> {
    const active = this.activeConversations.get(conversationId);
    if (!active) return false;
    if (active.processing) return true; // still processing previous turn

    // Check if max turns reached
    if (active.turnCount >= active.maxTurns) {
      this.endConversation(conversationId, cognitions);
      return false;
    }

    active.processing = true;

    try {
      // Determine current speaker
      const speakerId = active.conversation.participants[active.currentSpeakerIdx];
      const otherIdx = active.currentSpeakerIdx === 0 ? 1 : 0;
      const otherId = active.conversation.participants[otherIdx];

      const speakerAgent = this.world.getAgent(speakerId);
      const otherAgent = this.world.getAgent(otherId);
      const cognition = cognitions.get(speakerId);

      if (!speakerAgent || !otherAgent || !cognition) {
        this.endConversation(conversationId, cognitions);
        return false;
      }

      // Build conversation history
      const history = active.conversation.messages.map(
        m => `${m.agentName}: ${m.content}`,
      );

      // Generate response via LLM, with fallback on failure
      const boardContext = this.world.getBoardSummary();
      let response: string;
      try {
        response = await cognition.converse(otherAgent, history, boardContext);
      } catch {
        // Fallback dialogue when LLM is unavailable
        response = this.getFallbackDialogue(speakerAgent.config.name, otherAgent.config.name, active.turnCount);
      }

      // Extract [ACTION: ...] tags and execute social actions
      const actionMatches = response.matchAll(/\[ACTION:\s*(.+?)\]/gi);
      for (const match of actionMatches) {
        const actionIntent = match[1].trim();
        this.executeSocialAction(speakerId, speakerAgent.config.name, otherId, actionIntent, cognition);
      }

      // Strip the ACTION tag from the displayed message
      const displayResponse = response.replace(/\s*\[ACTION:\s*.+?\]/gi, '').trim();

      // Add message to conversation
      const message = {
        agentId: speakerId,
        agentName: speakerAgent.config.name,
        content: displayResponse || response,
        timestamp: Date.now(),
      };
      active.conversation.messages.push(message);

      // Broadcast (clean version without ACTION tags)
      this.broadcaster.agentSpeak(
        speakerId,
        speakerAgent.config.name,
        displayResponse || response,
        conversationId,
      );

      console.log(
        `[Conversation] ${speakerAgent.config.name}: "${response.substring(0, 80)}${response.length > 80 ? '...' : ''}"`,
      );

      active.turnCount++;
      active.currentSpeakerIdx = otherIdx;

      // Check if the speaker said goodbye
      const lower = response.toLowerCase();
      if (
        active.turnCount >= 2 &&
        (lower.includes('goodbye') ||
          lower.includes('see you') ||
          lower.includes('gotta go') ||
          lower.includes('take care') ||
          lower.includes('bye'))
      ) {
        this.endConversation(conversationId, cognitions);
        return false;
      }

      return true;
    } catch (err) {
      console.error(`[Conversation] Error advancing turn:`, err);
      this.endConversation(conversationId, cognitions);
      return false;
    } finally {
      active.processing = false;
    }
  }

  /**
   * Check if an agent is currently in a conversation.
   */
  isInConversation(agentId: string): boolean {
    for (const active of this.activeConversations.values()) {
      if (active.conversation.participants.includes(agentId)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Get the conversation ID for an agent, if any.
   */
  getAgentConversation(agentId: string): string | undefined {
    for (const [id, active] of this.activeConversations.entries()) {
      if (active.conversation.participants.includes(agentId)) {
        return id;
      }
    }
    return undefined;
  }

  private getFallbackDialogue(speakerName: string, otherName: string, turnCount: number): string {
    const greetings = [
      `Hey ${otherName}, nice to see you!`,
      `Oh, ${otherName}! How are you doing?`,
      `${otherName}, what a pleasant surprise!`,
      `Hi there! Beautiful day, isn't it?`,
      `Good to see you, ${otherName}.`,
    ];
    const midConvo = [
      `That's really interesting, I hadn't thought about it that way.`,
      `I've been meaning to explore more of the village.`,
      `Have you been to the market lately? They have some new things.`,
      `I was just thinking about that earlier today.`,
      `The village has been quite lively recently.`,
      `I wonder what the weather will be like tomorrow.`,
      `Tell me more, I'd love to hear about that.`,
      `You know, this place really feels like home.`,
    ];
    const farewells = [
      `Well, I should get going. See you around, ${otherName}!`,
      `It was nice chatting! Take care.`,
      `I have to run, but let's talk again soon. Goodbye!`,
      `See you later, ${otherName}!`,
    ];

    if (turnCount === 0) return greetings[Math.floor(Math.random() * greetings.length)];
    if (turnCount >= 3) return farewells[Math.floor(Math.random() * farewells.length)];
    return midConvo[Math.floor(Math.random() * midConvo.length)];
  }

  private endConversation(conversationId: string, cognitions?: Map<string, AgentCognition>): void {
    const active = this.activeConversations.get(conversationId);
    if (active) {
      console.log(
        `[Conversation] Ended after ${active.turnCount} turns`,
      );

      // Store conversation as memory for each participant
      if (cognitions && active.conversation.messages.length > 0) {
        void this.storeConversationMemories(active.conversation, cognitions);
      }
    }
    this.world.endConversation(conversationId);
    this.activeConversations.delete(conversationId);
    this.broadcaster.conversationEnd(conversationId);
  }

  /**
   * After a conversation ends, store what was said as memories for each participant.
   * Each agent gets a memory of the conversation from their perspective.
   */
  private async storeConversationMemories(
    conversation: Conversation,
    cognitions: Map<string, AgentCognition>,
  ): Promise<void> {
    const messages = conversation.messages;
    if (messages.length === 0) return;

    // Build a transcript
    const transcript = messages.map(m => `${m.agentName}: ${m.content}`).join('\n');

    for (const participantId of conversation.participants) {
      const cognition = cognitions.get(participantId);
      if (!cognition) continue;

      const participant = this.world.getAgent(participantId);
      const otherId = conversation.participants.find(id => id !== participantId);
      const other = otherId ? this.world.getAgent(otherId) : undefined;
      if (!participant || !other) continue;

      // Store the full conversation as a memory
      const memory: Memory = {
        id: crypto.randomUUID(),
        agentId: participantId,
        type: 'conversation',
        content: `I had a conversation with ${other.config.name}. Here's what was said:\n${transcript}`,
        importance: 6,
        timestamp: Date.now(),
        relatedAgentIds: [otherId!],
      };

      try {
        await cognition.addMemory(memory);
        console.log(`[Memory] ${participant.config.name} stored memory of conversation with ${other.config.name}`);
      } catch (err) {
        console.error(`[Memory] Failed to store conversation memory for ${participant.config.name}:`, err);
      }
    }
  }

  /**
   * Parse and execute a social action from an agent's conversation.
   * Actions can affect the world state: post to the board, transfer currency, etc.
   */
  private executeSocialAction(
    actorId: string,
    actorName: string,
    targetId: string,
    rawAction: string,
    cognition: AgentCognition,
  ): void {
    const lower = rawAction.toLowerCase();
    console.log(`[Social] ${actorName} action: ${rawAction}`);

    // --- DECREE / RULE / ANNOUNCEMENT ---
    // e.g. "decree - no one enters the tavern after dark"
    // e.g. "rule - everyone must pay 10 gold tax"
    // e.g. "announce - village meeting at the plaza"
    const boardMatch = lower.match(/^(decree|rule|announce(?:ment)?|rumor|threat|alliance|bounty)\s*[-:]\s*(.+)/);
    if (boardMatch) {
      const typeMap: Record<string, BoardPostType> = {
        decree: 'decree', rule: 'rule',
        announce: 'announcement', announcement: 'announcement',
        rumor: 'rumor', threat: 'threat',
        alliance: 'alliance', bounty: 'bounty',
      };
      const postType = typeMap[boardMatch[1]] || 'announcement';
      const content = boardMatch[2].trim();
      const target = this.world.getAgent(targetId);

      this.world.addBoardPost({
        id: crypto.randomUUID(),
        authorId: actorId,
        authorName: actorName,
        type: postType,
        content,
        timestamp: Date.now(),
        day: this.world.time.day,
        targetIds: target ? [targetId] : undefined,
      });

      this.broadcaster.boardPost(this.world.board[this.world.board.length - 1]);

      // Store as memory for the actor
      void cognition.addMemory({
        id: crypto.randomUUID(),
        agentId: actorId,
        type: 'plan',
        content: `I posted a ${postType} to the village board: "${content}"`,
        importance: 8,
        timestamp: Date.now(),
        relatedAgentIds: [],
      });
      return;
    }

    // --- GIVE / PAY / TRIBUTE ---
    // e.g. "give 10 gold to Mei"
    // e.g. "demand 20 gold from Yuki"
    const goldGiveMatch = lower.match(/(?:give|pay|send)\s+(\d+)\s*(?:gold|coins?|g)\s+to\s+(\w+)/);
    if (goldGiveMatch) {
      const amount = parseInt(goldGiveMatch[1]);
      const newBalance = this.world.updateAgentCurrency(actorId, -amount);
      const targetBalance = this.world.updateAgentCurrency(targetId, amount);
      this.broadcaster.agentCurrency(actorId, newBalance, -amount, `gave gold to ${this.world.getAgent(targetId)?.config.name}`);
      this.broadcaster.agentCurrency(targetId, targetBalance, amount, `received gold from ${actorName}`);
      console.log(`[Social] ${actorName} gave ${amount}G to ${this.world.getAgent(targetId)?.config.name}`);
      return;
    }

    const goldDemandMatch = lower.match(/(?:demand|take|steal|tax|extort)\s+(\d+)\s*(?:gold|coins?|g)\s+from\s+(\w+)/);
    if (goldDemandMatch) {
      const amount = parseInt(goldDemandMatch[1]);
      const target = this.world.getAgent(targetId);
      if (target) {
        const taken = Math.min(amount, target.currency);
        if (taken > 0) {
          const targetBalance = this.world.updateAgentCurrency(targetId, -taken);
          const actorBalance = this.world.updateAgentCurrency(actorId, taken);
          this.broadcaster.agentCurrency(targetId, targetBalance, -taken, `${actorName} took gold`);
          this.broadcaster.agentCurrency(actorId, actorBalance, taken, `took gold from ${target.config.name}`);
          console.log(`[Social] ${actorName} took ${taken}G from ${target.config.name}`);
        }
      }
      return;
    }

    // --- DEFAULT: store as intention memory ---
    // Anything that doesn't match a specific pattern still becomes a high-priority memory
    void cognition.addMemory({
      id: crypto.randomUUID(),
      agentId: actorId,
      type: 'plan',
      content: `After talking to ${this.world.getAgent(targetId)?.config.name}, I want to: ${rawAction}`,
      importance: 9,
      timestamp: Date.now(),
      relatedAgentIds: [targetId],
    });
  }
}
