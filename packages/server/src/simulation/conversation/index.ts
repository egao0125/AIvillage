import type { Conversation, Position } from '@ai-village/shared';
import { AgentCognition } from '@ai-village/ai-engine';
import type { World } from '../world.js';
import type { EventBroadcaster } from '../events.js';
import { ActionPipeline } from './action-pipeline.js';
import { PostConversationProcessor } from './post-conversation.js';
import { buildInstitutionContext } from './helpers.js';

interface ActiveConversation {
  conversation: Conversation;
  turnCount: number;
  maxTurns: number;
  currentSpeakerIdx: number;
  processing: boolean;
  agendas: Map<string, string>; // agentId -> pre-conversation agenda
}

export class ConversationManager {
  private activeConversations: Map<string, ActiveConversation> = new Map();
  private requestConversationFn?: (initiatorId: string, targetId: string) => boolean;
  private actionPipeline: ActionPipeline;
  private postProcessor: PostConversationProcessor;

  constructor(
    private world: World,
    private broadcaster: EventBroadcaster,
  ) {
    this.actionPipeline = new ActionPipeline(world, broadcaster);
    this.postProcessor = new PostConversationProcessor(world);

    // Wire the conversation lookup callback for social act handling
    this.actionPipeline.getAgentConversation = (agentId: string) => {
      for (const [id, active] of this.activeConversations.entries()) {
        if (active.conversation.participants.includes(agentId)) {
          return { conversationId: id, participants: [...active.conversation.participants] };
        }
      }
      return { conversationId: undefined, participants: [] };
    };
  }

  setRequestConversation(fn: (initiatorId: string, targetId: string) => boolean): void {
    this.requestConversationFn = fn;
  }

  /**
   * Start a new conversation between agents.
   * Accepts an array of agent IDs (2 or more for group conversations).
   * Also accepts two separate string args for backward compatibility.
   */
  startConversation(agentIdsOrFirst: string | string[], agent2Id?: string, location?: Position): string {
    let agentIds: string[];
    let loc: Position;

    if (Array.isArray(agentIdsOrFirst)) {
      agentIds = agentIdsOrFirst;
      loc = location ? { ...location } : { x: 0, y: 0 };
    } else {
      // Backward compatible: two separate string args
      agentIds = [agentIdsOrFirst, agent2Id!];
      loc = location ? { ...location } : { x: 0, y: 0 };
    }

    const id = crypto.randomUUID();
    // Safety valve only — goodbye detection handles natural endings
    const maxTurns = 12;

    const conversation: Conversation = {
      id,
      participants: agentIds,
      messages: [],
      location: loc,
      startedAt: Date.now(),
    };

    this.world.addConversation(conversation);
    this.activeConversations.set(id, {
      conversation,
      turnCount: 0,
      maxTurns,
      currentSpeakerIdx: 0,
      processing: false,
      agendas: new Map(),
    });

    const names = agentIds.map(aid => this.world.getAgent(aid)?.config.name ?? aid);
    console.log(
      `[Conversation] Started between ${names.join(', ')} (max ${maxTurns} turns)`,
    );

    // Broadcast conversation start so client can draw visual link
    this.broadcaster.conversationStart(id, agentIds);

    return id;
  }

  /**
   * Add a participant to an active conversation mid-way.
   */
  addParticipant(conversationId: string, agentId: string): void {
    const active = this.activeConversations.get(conversationId);
    if (!active) return;
    if (active.conversation.participants.includes(agentId)) return;

    active.conversation.participants.push(agentId);
    const agent = this.world.getAgent(agentId);
    console.log(
      `[Conversation] ${agent?.config.name ?? agentId} joined conversation ${conversationId}`,
    );
    this.broadcaster.conversationStart(conversationId, active.conversation.participants);
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
      const participants = active.conversation.participants;
      // Determine current speaker using round-robin modulo for N participants
      const speakerId = participants[active.currentSpeakerIdx % participants.length];
      const otherIds = participants.filter(id => id !== speakerId);

      const speakerAgent = this.world.getAgent(speakerId);
      const otherAgents = otherIds.map(id => this.world.getAgent(id)).filter(Boolean) as import('@ai-village/shared').Agent[];
      const cognition = cognitions.get(speakerId);

      if (!speakerAgent || otherAgents.length === 0 || !cognition) {
        this.endConversation(conversationId, cognitions);
        return false;
      }

      // Build conversation history
      const history = active.conversation.messages.map(
        m => `${m.agentName}: ${m.content}`,
      );

      // --- Build dialogue context ---
      const boardContext = cognition.knownPlaces.has('plaza') ? this.world.getBoardSummary() : undefined;
      const publicArtifacts = this.world.getPublicArtifacts().slice(-5);
      const artifactContext = publicArtifacts.length > 0
        ? publicArtifacts.map(a => `- [${a.type.toUpperCase()}] "${a.title}" by ${a.creatorName}: ${a.content.slice(0, 80)}`).join('\n')
        : undefined;
      const institutionContext = buildInstitutionContext(this.world, speakerId);

      // Secrets context — secrets the speaker knows about conversation partners
      const speakerSecrets = this.world.getSecretsFor(speakerId);
      const partnerIds = new Set(otherIds);
      const relevantSecrets = speakerSecrets.filter(s =>
        (s.holderId === speakerId || s.sharedWith.includes(speakerId)) &&
        (s.aboutAgentId && partnerIds.has(s.aboutAgentId))
      );
      const secretsContext = relevantSecrets.length > 0
        ? relevantSecrets.map(s => {
            const aboutName = this.world.getAgent(s.aboutAgentId!)?.config.name ?? 'someone';
            return `- About ${aboutName}: "${s.content}"`;
          }).join('\n')
        : undefined;

      const agenda = active.agendas.get(speakerId);

      // Trade context
      const speakerTrades = Array.from(this.world.pendingTrades.values())
        .filter(t => t.status === 'pending' && (t.fromAgentId === speakerId || t.toAgentId === speakerId));
      let tradeContext: string | undefined;
      if (speakerTrades.length > 0) {
        const tradeLines: string[] = [];
        for (const trade of speakerTrades) {
          const offerStr = trade.offering.map(i => `${i.qty} ${i.resource}`).join(', ');
          const requestStr = trade.requesting.map(i => `${i.qty} ${i.resource}`).join(', ');
          if (trade.fromAgentId === speakerId) {
            const toName = this.world.getAgent(trade.toAgentId)?.config.name ?? 'someone';
            tradeLines.push(`- You offered ${toName} ${offerStr} for their ${requestStr}. Waiting for response.`);
          } else {
            const fromName = this.world.getAgent(trade.fromAgentId)?.config.name ?? 'someone';
            tradeLines.push(`- ${fromName} offers you ${offerStr} for your ${requestStr}. Say [ACTION: accept trade] or [ACTION: reject trade].`);
          }
        }
        tradeContext = tradeLines.join('\n');
      }

      // Social ledger context
      const myLedger = speakerAgent.socialLedger ?? [];
      const otherIdSet = new Set(otherIds);
      const sharedEntries = myLedger.filter(e =>
        e.targetIds.some(id => otherIdSet.has(id))
      );
      let ledgerContext: string | undefined;
      if (sharedEntries.length > 0) {
        const ledgerLines = sharedEntries.map(e => {
          const tag = e.source === 'secondhand' ? ' (secondhand)' : '';
          return `- [${e.status}] ${e.description}${tag}`;
        });
        ledgerContext = `OUR HISTORY:\n${ledgerLines.join('\n')}`;
      }

      let combinedWorldContext = institutionContext || '';
      if (ledgerContext) {
        combinedWorldContext += (combinedWorldContext ? '\n\n' : '') + ledgerContext;
      }

      // Hint the LLM to wrap up when conversation is getting long
      const turnsLeft = active.maxTurns - active.turnCount;
      if (turnsLeft <= 4 && active.turnCount >= 4) {
        history.push(`[You feel the conversation winding down. Wrap up naturally — say goodbye or make a parting remark.]`);
      }

      // --- Generate dialogue ---
      let response: string;
      try {
        response = await cognition.talk(otherAgents, history, boardContext, combinedWorldContext || undefined, artifactContext, secretsContext, agenda, tradeContext);
      } catch (err) {
        // No fallback dialogue — end conversation when LLM fails
        console.error(`[Conversation] LLM failed for ${speakerAgent.config.name}:`, err);
        this.endConversation(conversationId, cognitions);
        return false;
      }

      // Detect and handle Claude safety refusal (breaks character)
      const REFUSAL_PATTERNS = [
        /I can't continue this/i,
        /I('d| would) be creating/i,
        /as an AI/i,
        /language model/i,
        /this crosses into/i,
        /breaks? character/i,
        /roleplay content/i,
        /psychological distress/i,
        /I('m| am) not (?:able|going) to/i,
        /this (?:scenario|setup|situation) (?:appears|seems)/i,
      ];
      const isRefusal = REFUSAL_PATTERNS.some(p => p.test(response));
      if (isRefusal) {
        console.log(`[Conversation] ${speakerAgent.config.name} safety refusal detected — ending conversation`);
        response = "I think I've said everything I can say tonight. Let's pick this up tomorrow when we've both rested.";
      }

      // --- Execute [ACTION: ...] tags ---
      const defaultTargetId = otherIds[0];
      const actionMatches = response.matchAll(/\[ACTION:\s*(.+?)\]/gi);
      for (const match of actionMatches) {
        const actionIntent = match[1].trim();
        this.actionPipeline.executeSocialAction(speakerId, speakerAgent.config.name, defaultTargetId, actionIntent, cognition, cognitions, this.requestConversationFn);
      }

      // Strip the ACTION tag from the displayed message
      const displayResponse = response.replace(/\s*\[ACTION:\s*.+?\]/gi, '').trim();

      // Strip narration from conversation history
      const dialogueOnly = AgentCognition.stripNarration(displayResponse || response);

      // Add cleaned message to conversation
      const message = {
        agentId: speakerId,
        agentName: speakerAgent.config.name,
        content: dialogueOnly,
        timestamp: Date.now(),
      };
      active.conversation.messages.push(message);

      // Broadcast cleaned dialogue
      this.broadcaster.agentSpeak(
        speakerId,
        speakerAgent.config.name,
        dialogueOnly,
        conversationId,
      );

      console.log(
        `[Conversation] ${speakerAgent.config.name}: "${response.substring(0, 80)}${response.length > 80 ? '...' : ''}"`,
      );

      active.turnCount++;
      // Round-robin to next speaker
      active.currentSpeakerIdx = (active.currentSpeakerIdx + 1) % participants.length;

      // Check if the speaker said goodbye
      const lower = response.toLowerCase();
      if (
        active.turnCount >= 2 &&
        (lower.includes('goodbye') ||
          lower.includes('see you') ||
          lower.includes('gotta go') ||
          lower.includes('take care') ||
          lower.includes('bye') ||
          lower.includes('farewell') ||
          lower.includes('until next time') ||
          lower.includes('i must go') ||
          lower.includes('i should go') ||
          lower.includes('walk away') ||
          lower.includes('walks away') ||
          lower.includes('turns to leave') ||
          lower.includes('heads off') ||
          lower.includes('wanders off') ||
          lower.includes('good day') ||
          lower.includes('be well'))
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

  /**
   * Parse and execute a social action (public interface — delegates to ActionPipeline).
   */
  async executeSocialAction(
    actorId: string,
    actorName: string,
    targetId: string,
    rawAction: string,
    cognition: AgentCognition,
    cognitions?: Map<string, AgentCognition>,
    requestConversation?: (initiatorId: string, targetId: string) => boolean,
  ): Promise<string> {
    return this.actionPipeline.executeSocialAction(
      actorId, actorName, targetId, rawAction, cognition, cognitions, requestConversation,
    );
  }

  private endConversation(conversationId: string, cognitions?: Map<string, AgentCognition>): void {
    const active = this.activeConversations.get(conversationId);
    if (active) {
      console.log(
        `[Conversation] Ended after ${active.turnCount} turns`,
      );

      // Store conversation as memory for each participant
      if (cognitions && active.conversation.messages.length > 0) {
        void this.postProcessor.process(active.conversation, cognitions);
      }
    }
    this.world.endConversation(conversationId);
    this.activeConversations.delete(conversationId);
    this.broadcaster.conversationEnd(conversationId);
  }
}
