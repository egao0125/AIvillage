import type { BoardPostType, Conversation, Item, Memory, Position, Secret, Artifact, Building, Institution, Agent } from '@ai-village/shared';
import { type AgentCognition, parseIntent, executeAction, RESOURCES, BUILDINGS, getGatherOptions, type ActionOutcome, type AgentState as ResolverAgentState, type WorldState as ResolverWorldState } from '@ai-village/ai-engine';
import { AREA_DESCRIPTIONS } from '../map/starting-knowledge.js';
import type { World } from './world.js';
import type { EventBroadcaster } from './events.js';

interface ActiveConversation {
  conversation: Conversation;
  turnCount: number;
  maxTurns: number;
  currentSpeakerIdx: number;
  processing: boolean;
  agendas: Map<string, string>; // agentId → pre-conversation agenda
}

export class ConversationManager {
  private activeConversations: Map<string, ActiveConversation> = new Map();
  private recentFailures: Map<string, { count: number; lastType: string; lastLocation: string }> = new Map();
  private requestConversationFn?: (initiatorId: string, targetId: string) => boolean;

  constructor(
    private world: World,
    private broadcaster: EventBroadcaster,
  ) {}

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

      // Generate response via LLM, with fallback on failure
      const boardContext = this.world.getBoardSummary();
      const publicArtifacts = this.world.getPublicArtifacts().slice(-5);
      const artifactContext = publicArtifacts.length > 0
        ? publicArtifacts.map(a => `- [${a.type.toUpperCase()}] "${a.title}" by ${a.creatorName}: ${a.content.slice(0, 80)}`).join('\n')
        : undefined;
      // Build institution context for the speaking agent
      const institutionContext = this.buildInstitutionContext(speakerId);

      // Build secrets context — secrets the speaker knows about conversation partners
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

      // Build trade context — pending trades involving the speaker
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

      // Hint the LLM to wrap up when conversation is getting long
      const turnsLeft = active.maxTurns - active.turnCount;
      if (turnsLeft <= 4 && active.turnCount >= 4) {
        history.push(`[You feel the conversation winding down. Wrap up naturally — say goodbye or make a parting remark.]`);
      }

      let response: string;
      try {
        response = await cognition.talk(otherAgents, history, boardContext, institutionContext || undefined, artifactContext, secretsContext, agenda, tradeContext);
      } catch (err) {
        // No fallback dialogue — end conversation when LLM fails
        console.error(`[Conversation] LLM failed for ${speakerAgent.config.name}:`, err);
        this.endConversation(conversationId, cognitions);
        return false;
      }

      // Extract [ACTION: ...] tags and execute social actions
      // Use the first other participant as default target for actions
      const defaultTargetId = otherIds[0];
      const actionMatches = response.matchAll(/\[ACTION:\s*(.+?)\]/gi);
      for (const match of actionMatches) {
        const actionIntent = match[1].trim();
        this.executeSocialAction(speakerId, speakerAgent.config.name, defaultTargetId, actionIntent, cognition, cognitions, this.requestConversationFn);
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
      if (!participant) continue;

      const otherIds = conversation.participants.filter(id => id !== participantId);
      const otherNames = otherIds
        .map(id => this.world.getAgent(id)?.config.name)
        .filter(Boolean);

      if (otherNames.length === 0) continue;

      const othersLabel = otherNames.length === 1
        ? otherNames[0]
        : `${otherNames.slice(0, -1).join(', ')} and ${otherNames[otherNames.length - 1]}`;

      // Score conversation importance dynamically — a deal or betrayal matters more than small talk
      const convContent = `I had a conversation with ${othersLabel}. Here's what was said:\n${transcript}`;
      let importance = 6;
      try {
        importance = await cognition.scoreImportance(convContent, 'conversation');
      } catch {}

      // Store the full conversation as a memory
      const memory: Memory = {
        id: crypto.randomUUID(),
        agentId: participantId,
        type: 'conversation',
        content: convContent,
        importance,
        timestamp: Date.now(),
        relatedAgentIds: otherIds,
      };

      try {
        await cognition.addMemory(memory);
        console.log(`[Memory] ${participant.config.name} stored memory of conversation with ${othersLabel}`);
      } catch (err) {
        console.error(`[Memory] Failed to store conversation memory for ${participant.config.name}:`, err);
      }
    }

    // Extract commitments — scan each agent's lines for promise language
    // Stored as separate high-importance memories so they surface in planDay()
    for (const participantId of conversation.participants) {
      const cognition = cognitions.get(participantId);
      const participant = this.world.getAgent(participantId);
      if (!cognition || !participant) continue;

      const agentLines = messages
        .filter(m => m.agentId === participantId)
        .map(m => m.content);

      const commitmentPattern = /\b(i('ll| will| promise| swear)|tomorrow|at dawn|meet (you|me)|i('m| am) (going|coming)|you have my word|count on me|i won't (bail|forget|flake))\b/i;

      const commitmentLines = agentLines.filter(line => commitmentPattern.test(line));

      if (commitmentLines.length > 0) {
        const otherNames = conversation.participants
          .filter(id => id !== participantId)
          .map(id => this.world.getAgent(id)?.config.name)
          .filter(Boolean);

        try {
          await cognition.addMemory({
            id: crypto.randomUUID(),
            agentId: participantId,
            type: 'plan',
            content: `COMMITMENT I made to ${otherNames.join(', ')}: ${commitmentLines.join(' ')}`,
            importance: 8,
            timestamp: Date.now(),
            relatedAgentIds: conversation.participants.filter(id => id !== participantId),
          });
          console.log(`[Memory] ${participant.config.name} stored commitment to ${otherNames.join(', ')}`);

          // Bidirectional: store the promise for the OTHER participants too
          for (const otherId of conversation.participants.filter(id => id !== participantId)) {
            const otherCognition = cognitions.get(otherId);
            if (!otherCognition) continue;
            try {
              await otherCognition.addMemory({
                id: crypto.randomUUID(),
                agentId: otherId,
                type: 'plan',
                content: `PROMISE from ${participant.config.name}: ${commitmentLines.join(' ')}`,
                importance: 7,
                timestamp: Date.now(),
                relatedAgentIds: [participantId],
              });
            } catch {}
          }
        } catch (err) {
          console.error(`[Memory] Failed to store commitment for ${participant.config.name}:`, err);
        }
      }
    }

    // --- Gossip extraction: hearsay memories for third-party mentions ---
    const participantNameSet = new Set(
      conversation.participants
        .map(id => this.world.getAgent(id)?.config.name?.toLowerCase())
        .filter((n): n is string => !!n)
    );

    // Build agent name lookup: lowercased name -> {id, fullName}
    const agentNameMap = new Map<string, { id: string; fullName: string }>();
    for (const agent of this.world.agents.values()) {
      if (agent.alive === false) continue;
      const name = agent.config.name;
      agentNameMap.set(name.toLowerCase(), { id: agent.id, fullName: name });
      // Index first name for partial matching (only if 3+ chars to avoid false positives)
      const firstName = name.split(' ')[0];
      if (firstName.length >= 3 && firstName.toLowerCase() !== name.toLowerCase()) {
        agentNameMap.set(firstName.toLowerCase(), { id: agent.id, fullName: name });
      }
    }

    for (const msg of messages) {
      const speakerId = msg.agentId;
      const speakerName = msg.agentName;

      // Find third-party agent mentions in this message
      const mentionedAgents: { id: string; fullName: string }[] = [];
      for (const [nameKey, agentInfo] of agentNameMap) {
        if (participantNameSet.has(nameKey)) continue; // skip conversation participants
        if (agentInfo.id === speakerId) continue; // skip self
        // Word-boundary check to avoid false positives
        const regex = new RegExp(`\\b${nameKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
        if (regex.test(msg.content)) {
          if (!mentionedAgents.some(m => m.id === agentInfo.id)) {
            mentionedAgents.push(agentInfo);
          }
        }
      }

      if (mentionedAgents.length === 0) continue;

      // Create hearsay memories for each non-speaker participant
      for (const participantId of conversation.participants) {
        if (participantId === speakerId) continue;
        const listenerCognition = cognitions.get(participantId);
        if (!listenerCognition) continue;

        for (const mentioned of mentionedAgents) {
          try {
            await listenerCognition.addMemory({
              id: crypto.randomUUID(),
              agentId: participantId,
              type: 'observation',
              content: `${speakerName} told me about ${mentioned.fullName}: "${msg.content}"`,
              importance: 5,
              timestamp: Date.now(),
              relatedAgentIds: [speakerId, mentioned.id],
              sourceAgentId: speakerId,
              hearsayDepth: 1,
            });
          } catch {}
        }
      }
    }

    // --- Structured fact extraction (one cheap LLM call per participant) ---
    await this.extractAndStoreFacts(conversation, cognitions);
  }

  /**
   * Extract structured facts from a conversation transcript and store each as a separate memory.
   * Place facts update knownPlaces immediately. Person facts tag relatedAgentIds for gossip.
   * Agreement facts are stored for both participants.
   */
  private async extractAndStoreFacts(
    conversation: Conversation,
    cognitions: Map<string, AgentCognition>,
  ): Promise<void> {
    const messages = conversation.messages;
    if (messages.length < 2) return;

    const transcript = messages.map(m => `${m.agentName}: ${m.content}`).join('\n');

    // Build area key lookup from AREA_DESCRIPTIONS keys + area names
    const areaNameToKey = new Map<string, string>();
    for (const [key, desc] of Object.entries(AREA_DESCRIPTIONS)) {
      areaNameToKey.set(key, key);
      // Also index by display name (e.g. "Bakery" -> "bakery")
      const displayName = desc.split(' — ')[0].toLowerCase();
      areaNameToKey.set(displayName, key);
    }

    for (const participantId of conversation.participants) {
      const cognition = cognitions.get(participantId);
      const participant = this.world.getAgent(participantId);
      if (!cognition || !participant) continue;

      const otherIds = conversation.participants.filter(id => id !== participantId);
      const otherNames = otherIds
        .map(id => this.world.getAgent(id)?.config.name)
        .filter(Boolean) as string[];

      let facts: { category: string; content: string; about?: string; source?: string }[];
      try {
        facts = await cognition.extractFacts(transcript, participant.config.name, otherNames);
      } catch (err) {
        console.error(`[Facts] Extraction failed for ${participant.config.name}:`, err);
        continue;
      }

      if (facts.length === 0) continue;
      console.log(`[Facts] ${participant.config.name} extracted ${facts.length} facts`);

      for (const fact of facts) {
        const sourceName = fact.source || otherNames[0] || 'someone';

        switch (fact.category) {
          case 'place': {
            // Try to match an area key from content
            const contentLower = fact.content.toLowerCase();
            for (const [name, key] of areaNameToKey) {
              if (contentLower.includes(name)) {
                cognition.addDiscovery(key, AREA_DESCRIPTIONS[key]);
                break;
              }
            }
            await cognition.addMemory({
              id: crypto.randomUUID(),
              agentId: participantId,
              type: 'observation',
              content: `${sourceName} told me: ${fact.content}`,
              importance: 6,
              timestamp: Date.now(),
              relatedAgentIds: otherIds,
            });
            break;
          }

          case 'resource': {
            await cognition.addMemory({
              id: crypto.randomUUID(),
              agentId: participantId,
              type: 'observation',
              content: `${sourceName} told me: ${fact.content}`,
              importance: 6,
              timestamp: Date.now(),
              relatedAgentIds: otherIds,
            });
            break;
          }

          case 'person': {
            const mentionedAgent = fact.about ? this.findAgentByName(fact.about) : undefined;
            const relatedIds = [...otherIds];
            if (mentionedAgent && !relatedIds.includes(mentionedAgent.id)) {
              relatedIds.push(mentionedAgent.id);
            }
            await cognition.addMemory({
              id: crypto.randomUUID(),
              agentId: participantId,
              type: 'observation',
              content: `${sourceName} told me: ${fact.content}`,
              importance: 5,
              timestamp: Date.now(),
              relatedAgentIds: relatedIds,
              sourceAgentId: otherIds[0],
              hearsayDepth: 1,
            });
            break;
          }

          case 'agreement': {
            // Store for this participant
            await cognition.addMemory({
              id: crypto.randomUUID(),
              agentId: participantId,
              type: 'plan',
              content: `AGREEMENT with ${otherNames.join(', ')}: ${fact.content}`,
              importance: 7,
              timestamp: Date.now(),
              relatedAgentIds: otherIds,
            });
            // Store for other participants too
            for (const otherId of otherIds) {
              const otherCognition = cognitions.get(otherId);
              if (!otherCognition) continue;
              try {
                await otherCognition.addMemory({
                  id: crypto.randomUUID(),
                  agentId: otherId,
                  type: 'plan',
                  content: `AGREEMENT with ${participant.config.name}: ${fact.content}`,
                  importance: 7,
                  timestamp: Date.now(),
                  relatedAgentIds: [participantId],
                });
              } catch {}
            }
            break;
          }

          case 'need': {
            await cognition.addMemory({
              id: crypto.randomUUID(),
              agentId: participantId,
              type: 'observation',
              content: `${sourceName} said they need: ${fact.content}`,
              importance: 4,
              timestamp: Date.now(),
              relatedAgentIds: otherIds,
            });
            break;
          }

          case 'skill': {
            await cognition.addMemory({
              id: crypto.randomUUID(),
              agentId: participantId,
              type: 'observation',
              content: `${sourceName} told me: ${fact.content}`,
              importance: 5,
              timestamp: Date.now(),
              relatedAgentIds: otherIds,
            });
            break;
          }
        }
      }
    }
  }

  /**
   * Parse and execute a social action from an agent's conversation or think() output.
   * Uses deterministic action resolver — no LLM involved.
   */
  async executeSocialAction(
    actorId: string,
    actorName: string,
    targetId: string,
    rawAction: string,
    cognition: AgentCognition,
    cognitions?: Map<string, AgentCognition>,
    requestConversation?: (initiatorId: string, targetId: string) => boolean,
  ): Promise<void> {
    console.log(`[Social] ${actorName} action: ${rawAction}`);
    const actor = this.world.getAgent(actorId);
    if (!actor) return;

    const area = this.world.getAreaAt(actor.position);
    const nearbyFull = this.world.getNearbyAgents(actor.position, 8)
      .filter(a => a.id !== actorId && a.alive !== false);

    // Build resolver-compatible agent state
    const agentState: ResolverAgentState = {
      id: actorId,
      name: actorName,
      location: area?.id ?? 'unknown',
      energy: actor.vitals?.energy ?? 100,
      hunger: actor.vitals?.hunger ?? 0,
      health: actor.vitals?.health ?? 100,
      inventory: this.buildInventoryForResolver(actor),
      skills: this.buildSkillsForResolver(actor),
      nearbyAgents: nearbyFull.map(a => ({ id: a.id, name: a.config.name })),
    };

    // Build world state for resolver
    const worldState = this.buildWorldStateForResolver();

    // Deterministic resolution — no LLM
    const intent = parseIntent(rawAction, agentState);
    const outcome = executeAction(intent, agentState, worldState);

    console.log(`[Social] ${actorName} → ${outcome.type}: ${outcome.success ? 'SUCCESS' : 'FAILED'} — ${outcome.description}`);

    // Apply outcome to actual world + store memory
    this.applyOutcome(actorId, actorName, outcome, cognition, cognitions, requestConversation);
  }

  /**
   * Map Actor's Item[] inventory to resolver's {resource, qty}[] format.
   */
  private buildInventoryForResolver(actor: Agent): { resource: string; qty: number }[] {
    const counts = new Map<string, number>();
    for (const item of actor.inventory) {
      const key = item.name.toLowerCase().replace(/\s+/g, '_');
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return Array.from(counts.entries()).map(([resource, qty]) => ({ resource, qty }));
  }

  /**
   * Map Actor's Skill[] to resolver's Record<string, {level, xp}> format.
   */
  private buildSkillsForResolver(actor: Agent): Record<string, { level: number; xp: number }> {
    const skills: Record<string, { level: number; xp: number }> = {};
    for (const s of actor.skills) {
      if (!s.name) continue;
      skills[s.name.toLowerCase()] = { level: s.level, xp: s.xp ?? 0 };
    }
    return skills;
  }

  /**
   * Build world state for the deterministic resolver.
   */
  private buildWorldStateForResolver(): ResolverWorldState {
    return {
      season: this.world.weather.season,
      dailyGatherCounts: this.world.dailyGatherCounts,
      activeBuildProjects: this.world.activeBuildProjects,
      pendingTrades: this.world.pendingTrades,
      getAgentInventory: (agentId: string) => {
        const agent = this.world.getAgent(agentId);
        if (!agent) return [];
        return this.buildInventoryForResolver(agent);
      },
    };
  }

  /**
   * Apply a deterministic ActionOutcome to the world state.
   * Handles item creation/removal, skill XP, vitals, trades, builds, and memory feedback.
   */
  private applyOutcome(
    actorId: string,
    actorName: string,
    outcome: ActionOutcome,
    cognition: AgentCognition,
    cognitions?: Map<string, AgentCognition>,
    requestConversation?: (initiatorId: string, targetId: string) => boolean,
  ): void {
    const actor = this.world.getAgent(actorId);
    if (!actor) return;

    // --- Items consumed ---
    if (outcome.itemsConsumed) {
      for (const consumed of outcome.itemsConsumed) {
        for (let i = 0; i < consumed.qty; i++) {
          const item = actor.inventory.find(it => it.name.toLowerCase().replace(/\s+/g, '_') === consumed.resource);
          if (item) this.world.removeItem(item.id);
        }
      }
      this.broadcaster.agentInventory(actorId, actor.inventory);
    }

    // --- Items gained (apply gather_bonus from buildings) ---
    if (outcome.itemsGained) {
      if (outcome.type === 'gather') {
        const area = this.world.getAreaAt(actor.position);
        if (area) {
          let gatherBonus = 0;
          for (const b of this.world.getBuildingsAt(area.id)) {
            if (!b.defId || !BUILDINGS[b.defId]) continue;
            const bDef = BUILDINGS[b.defId];
            const gatherEffect = bDef.effects?.find((e: any) => e.type === 'gather_bonus');
            if (gatherEffect) gatherBonus = Math.max(gatherBonus, gatherEffect.value);
          }
          if (gatherBonus > 0) {
            for (const gained of outcome.itemsGained) {
              const extra = Math.floor(gained.qty * gatherBonus);
              if (extra > 0) {
                gained.qty += extra;
                console.log(`[Building] gather_bonus +${extra} ${gained.resource} (${gatherBonus} bonus)`);
              }
            }
          }
        }
      }
      for (const gained of outcome.itemsGained) {
        const resDef = RESOURCES[gained.resource];
        for (let i = 0; i < gained.qty; i++) {
          const item: Item = {
            id: crypto.randomUUID(),
            name: resDef?.name ?? gained.resource,
            description: `${resDef?.name ?? gained.resource} obtained by ${actorName}`,
            ownerId: actorId,
            createdBy: actorId,
            value: resDef?.baseTradeValue ?? 5,
            type: (resDef?.type === 'food' || (resDef?.type === 'raw' && (resDef?.nutritionValue ?? 0) > 0)) ? 'food' : resDef?.type === 'tool' ? 'tool' : resDef?.type === 'medicine' ? 'medicine' : 'material',
          };
          this.world.addItem(item);
        }
      }
      this.broadcaster.agentInventory(actorId, actor.inventory);

      // Update daily gather count
      if (outcome.type === 'gather') {
        // Find which gather def was used by matching resource + location
        const area = this.world.getAreaAt(actor.position);
        const areaId = area?.id ?? 'unknown';
        const resource = outcome.itemsGained[0]?.resource;
        // Build a key from gathered resource info for daily tracking
        const gatherKey = `${areaId}_${resource}`;
        // Try to match exact gather def IDs
        const options = getGatherOptions(areaId);
        for (const gDef of options) {
          if (gDef.yields.some((y: any) => y.resource === resource)) {
            const current = this.world.dailyGatherCounts.get(gDef.id) ?? 0;
            this.world.dailyGatherCounts.set(gDef.id, current + 1);
            break;
          }
        }
      }
    }

    // --- Skill XP (apply craft_speed bonus from buildings as extra XP) ---
    if (outcome.skillXpGained) {
      if (outcome.type === 'craft') {
        const area = this.world.getAreaAt(actor.position);
        if (area) {
          let craftSpeed = 1;
          for (const b of this.world.getBuildingsAt(area.id)) {
            if (!b.defId || !BUILDINGS[b.defId]) continue;
            const bDef = BUILDINGS[b.defId];
            const craftEffect = bDef.effects?.find((e: any) => e.type === 'craft_speed');
            if (craftEffect) craftSpeed = Math.min(craftSpeed, craftEffect.value);
          }
          if (craftSpeed < 1) {
            const bonus = 1 - craftSpeed; // e.g. 0.7 → 30% bonus
            const extraXp = Math.round(outcome.skillXpGained.xp * bonus);
            outcome.skillXpGained.xp += extraXp;
            console.log(`[Building] craft_speed bonus +${extraXp} XP (${Math.round(bonus * 100)}% faster)`);
          }
        }
      }
      this.world.addSkillXP(actorId, outcome.skillXpGained.skill, outcome.skillXpGained.xp);
      const updatedSkill = actor.skills.find(s => s.name === outcome.skillXpGained!.skill);
      if (updatedSkill) this.broadcaster.agentSkill(actorId, updatedSkill);
    }

    // --- Vitals ---
    if (actor.vitals) {
      if (outcome.energySpent !== 0) {
        actor.vitals.energy = Math.max(0, Math.min(100, actor.vitals.energy - outcome.energySpent));
      }
      if (outcome.hungerChange !== 0) {
        actor.vitals.hunger = Math.max(0, Math.min(100, actor.vitals.hunger + outcome.hungerChange));
      }
      if (outcome.healthChange !== 0) {
        actor.vitals.health = Math.max(0, Math.min(100, actor.vitals.health + outcome.healthChange));
      }
    }

    // --- Trade proposals ---
    if (outcome.tradeProposal) {
      if (outcome.type === 'trade_offer') {
        this.world.pendingTrades.set(outcome.tradeProposal.id, outcome.tradeProposal);
      } else if (outcome.type === 'trade_accept' && outcome.tradeProposal.status === 'accepted') {
        // Execute the actual item transfers for accepted trade
        const trade = outcome.tradeProposal;
        this.world.pendingTrades.delete(trade.id);

        // Transfer items from proposer to acceptor (offering)
        for (const item of trade.offering) {
          const fromAgent = this.world.getAgent(trade.fromAgentId);
          if (fromAgent) {
            for (let i = 0; i < item.qty; i++) {
              const invItem = fromAgent.inventory.find(it => it.name.toLowerCase().replace(/\s+/g, '_') === item.resource);
              if (invItem) this.world.transferItem(invItem.id, trade.fromAgentId, actorId);
            }
          }
        }
        // Transfer items from acceptor to proposer (requesting)
        for (const item of trade.requesting) {
          for (let i = 0; i < item.qty; i++) {
            const invItem = actor.inventory.find(it => it.name.toLowerCase().replace(/\s+/g, '_') === item.resource);
            if (invItem) this.world.transferItem(invItem.id, actorId, trade.fromAgentId);
          }
        }

        this.broadcaster.agentInventory(actorId, actor.inventory);
        const fromAgent = this.world.getAgent(trade.fromAgentId);
        if (fromAgent) this.broadcaster.agentInventory(trade.fromAgentId, fromAgent.inventory);

        // Store memory for the other trader
        const proposerCog = cognitions?.get(trade.fromAgentId);
        if (proposerCog) {
          void proposerCog.addMemory({
            id: crypto.randomUUID(), agentId: trade.fromAgentId, type: 'observation',
            content: `${actorName} accepted my trade. I gave ${trade.offering.map(i => `${i.qty} ${i.resource}`).join(', ')} and received ${trade.requesting.map(i => `${i.qty} ${i.resource}`).join(', ')}.`,
            importance: 7, timestamp: Date.now(), relatedAgentIds: [actorId],
          }).catch(() => {});
        }
      } else if (outcome.type === 'trade_reject' && outcome.tradeProposal) {
        this.world.pendingTrades.delete(outcome.tradeProposal.id);
      }
    }

    // --- Build progress ---
    if (outcome.buildProgress) {
      const bp = outcome.buildProgress;
      if (bp.buildingId.startsWith('new_')) {
        // New build project
        const defId = bp.buildingId.replace('new_', '');
        const area = this.world.getAreaAt(actor.position);
        const projectId = crypto.randomUUID();
        this.world.activeBuildProjects.set(projectId, {
          buildingDefId: defId,
          sessionsComplete: bp.session,
          ownerId: actorId,
          location: area?.id ?? 'unknown',
        });
      } else {
        // Existing project
        const project = this.world.activeBuildProjects.get(bp.buildingId);
        if (project) {
          project.sessionsComplete = bp.session;
          if (bp.complete) {
            const buildDef = BUILDINGS[project.buildingDefId];
            this.world.activeBuildProjects.delete(bp.buildingId);
            if (buildDef) {
              const bArea = this.world.getAreaAt(actor.position);
              const building: Building = {
                id: bp.buildingId,
                name: buildDef.name,
                type: buildDef.category ?? 'structure',
                description: buildDef.description,
                ownerId: actorId,
                areaId: bArea?.id ?? 'unknown',
                durability: buildDef.baseDurability ?? 100,
                maxDurability: buildDef.baseDurability ?? 100,
                effects: buildDef.effects?.map((e: any) => e.type) ?? [],
                builtBy: actorName,
                builtAt: this.world.time.totalMinutes,
                materials: buildDef.materials.map((m: any) => `${m.qty} ${m.resource}`),
                defId: project.buildingDefId,
              };
              this.world.addBuilding(building);
            }
            this.broadcaster.agentAction(actorId, `finished building ${buildDef?.name ?? 'structure'}!`, '🏗️');
          }
        }
      }
    }

    // --- Teach result ---
    if (outcome.teachResult) {
      // Find the target agent and update their skill
      const targetName = outcome.description.match(/Taught (\w+)/)?.[1];
      if (targetName) {
        const target = this.findAgentByName(targetName);
        if (target) {
          this.world.addSkill(target.id, {
            name: outcome.teachResult.skill,
            level: outcome.teachResult.studentNewLevel,
            xp: 0,
            learnedFrom: actorId,
          });
          const updatedSkill = target.skills.find(s => s.name === outcome.teachResult!.skill);
          if (updatedSkill) this.broadcaster.agentSkill(target.id, updatedSkill);

          // Memory for student
          const studentCog = cognitions?.get(target.id);
          if (studentCog) {
            void studentCog.addMemory({
              id: crypto.randomUUID(), agentId: target.id, type: 'observation',
              content: `${actorName} taught me ${outcome.teachResult.skill}. I'm now level ${outcome.teachResult.studentNewLevel}.`,
              importance: 7, timestamp: Date.now(), relatedAgentIds: [actorId],
            }).catch(() => {});
          }
        }
      }
    }

    // --- Give (transfer items to target) ---
    if (outcome.type === 'give' && outcome.success) {
      const targetName = outcome.description.match(/to (\w+)/)?.[1];
      if (targetName) {
        const target = this.findAgentByName(targetName);
        if (target && outcome.itemsConsumed) {
          for (const consumed of outcome.itemsConsumed) {
            // Items already removed from actor above — now create for target
            const resDef = RESOURCES[consumed.resource];
            for (let i = 0; i < consumed.qty; i++) {
              const item: Item = {
                id: crypto.randomUUID(),
                name: resDef?.name ?? consumed.resource,
                description: `${resDef?.name ?? consumed.resource} received from ${actorName}`,
                ownerId: target.id,
                createdBy: actorId,
                value: resDef?.baseTradeValue ?? 5,
                type: (resDef?.type === 'food' || (resDef?.type === 'raw' && (resDef?.nutritionValue ?? 0) > 0)) ? 'food' : resDef?.type === 'tool' ? 'tool' : resDef?.type === 'medicine' ? 'medicine' : 'material',
              };
              this.world.addItem(item);
            }
          }
          this.broadcaster.agentInventory(target.id, target.inventory);

          // Memory for recipient
          const recipientCog = cognitions?.get(target.id);
          if (recipientCog) {
            void recipientCog.addMemory({
              id: crypto.randomUUID(), agentId: target.id, type: 'observation',
              content: `${actorName} gave me ${outcome.itemsConsumed.map(i => `${i.qty} ${i.resource}`).join(', ')}.`,
              importance: 7, timestamp: Date.now(), relatedAgentIds: [actorId],
            }).catch(() => {});
          }
        }
      }
    }

    // --- Post on board ---
    if (outcome.type === 'post' && outcome.success) {
      const messageMatch = outcome.description.match(/"(.+)"/);
      if (messageMatch) {
        const post = {
          id: crypto.randomUUID(),
          authorId: actorId,
          authorName: actorName,
          type: 'announcement' as BoardPostType,
          content: messageMatch[1],
          timestamp: Date.now(),
          day: this.world.time.day,
        };
        this.world.addBoardPost(post);
        this.broadcaster.boardPost(post);
        this.broadcaster.agentAction(actorId, `posted: "${messageMatch[1].slice(0, 60)}"`, '📋');
      }
    }

    // --- Talk (request conversation) ---
    if (outcome.type === 'talk' && outcome.success && requestConversation) {
      const targetName = outcome.description.match(/talk to (\w+)/)?.[1];
      if (targetName) {
        const target = this.findAgentByName(targetName);
        if (target) {
          requestConversation(actorId, target.id);
        }
      }
    }

    // --- Intent (internal thought, not broadcast) ---
    if (outcome.type === 'intent') {
      void cognition.addMemory({
        id: crypto.randomUUID(),
        agentId: actorId,
        type: 'thought',
        content: outcome.description,
        importance: 6,
        timestamp: Date.now(),
        relatedAgentIds: [],
      });
      // Not broadcast — feeds the next plan/think cycle
      return;
    }

    // --- Social act (declaration, promise, threat, etc.) ---
    if (outcome.type === 'social') {
      const rawText = (outcome.description.replace(/^You declared: "?|"$/g, '') || outcome.description).trim();

      // Determine who hears this:
      // 1. If in a conversation → conversation participants hear it directly
      // 2. If not → only agents within 3 tiles (overhearing distance)
      let hearers: Agent[] = [];
      const conversationId = this.getAgentConversation(actorId);
      if (conversationId) {
        const active = this.activeConversations.get(conversationId);
        if (active) {
          hearers = active.conversation.participants
            .filter(id => id !== actorId)
            .map(id => this.world.getAgent(id))
            .filter((a): a is Agent => !!a && a.alive !== false);
        }
      } else {
        // Not in conversation — overhearing radius of 3 tiles
        hearers = this.world.getNearbyAgents(actor.position, 3)
          .filter(a => a.id !== actorId && a.alive !== false);
      }

      const hearerNames = hearers.map(a => a.config.name);
      const whoHeard = hearerNames.length > 0
        ? `Heard by: ${hearerNames.join(', ')}.`
        : 'Nobody was around to hear you.';
      const meaning = hearerNames.length > 0
        ? 'This is a claim, not a fact. Whether anyone respects it depends on whether they agree.'
        : 'A declaration with no audience is just words to yourself.';

      // Store memory for the acting agent
      void cognition.addMemory({
        id: crypto.randomUUID(),
        agentId: actorId,
        type: 'action_outcome',
        content: `${outcome.description}\n${whoHeard}\n${meaning}`,
        importance: 5,
        timestamp: Date.now(),
        relatedAgentIds: hearers.map(a => a.id),
        actionSuccess: true,
      });

      // Broadcast the action (UI shows it, but only nearby agents actually "heard" it)
      this.broadcaster.agentAction(actorId, outcome.description.slice(0, 80), '💬');

      // Store observation memory + trigger think() for each hearer
      if (cognitions) {
        for (const witness of hearers) {
          const witnessCognition = cognitions.get(witness.id);
          if (!witnessCognition) continue;

          // Store what the witness observed
          void witnessCognition.addMemory({
            id: crypto.randomUUID(),
            agentId: witness.id,
            type: 'observation',
            content: `${actorName} said: "${rawText}"`,
            importance: 5,
            timestamp: Date.now(),
            relatedAgentIds: [actorId],
          });

          // Trigger immediate think() — witness reacts in real-time
          void witnessCognition.think(
            `${actorName} just said: "${rawText}"`,
            `You are at ${this.world.getAreaAt(witness.position)?.id ?? 'somewhere'}. ${actorName} is nearby.`,
          ).then(output => {
            if (output.actions) {
              for (const action of output.actions) {
                void this.executeSocialAction(
                  witness.id, witness.config.name, '', action, witnessCognition, cognitions, requestConversation,
                );
              }
            }
            if (output.mood) {
              witness.mood = output.mood;
              this.broadcaster.agentMood(witness.id, output.mood);
            }
          }).catch(() => {});
        }
      }

      // Apply vitals (energy cost)
      if (actor.vitals && outcome.energySpent !== 0) {
        actor.vitals.energy = Math.max(0, Math.min(100, actor.vitals.energy - outcome.energySpent));
      }
      return;
    }

    // --- Broadcast action ---
    const emoji = outcome.success
      ? (outcome.type === 'gather' ? '🌾' : outcome.type === 'craft' ? '🔨' : outcome.type === 'build' ? '🏗️' : outcome.type === 'eat' ? '🍽️' : outcome.type === 'rest' ? '💤' : outcome.type === 'sleep' ? '😴' : outcome.type === 'trade_offer' || outcome.type === 'trade_accept' ? '🤝' : outcome.type === 'teach' ? '📚' : outcome.type === 'give' ? '🎁' : outcome.type === 'steal' ? '🫣' : outcome.type === 'fight' ? '⚔️' : outcome.type === 'destroy' ? '💥' : outcome.type === 'repair' ? '🔧' : '✅')
      : '❌';
    this.broadcaster.agentAction(actorId, outcome.description.slice(0, 80), emoji);

    // --- Store structured feedback as memory ---
    const inventorySummary = actor.inventory.length > 0
      ? actor.inventory.reduce((acc, item) => {
          const key = item.name;
          acc[key] = (acc[key] || 0) + 1;
          return acc;
        }, {} as Record<string, number>)
      : {};
    const invStr = Object.entries(inventorySummary).map(([name, qty]) => `${name} ×${qty}`).join(', ') || 'nothing';

    const memoryLines = [
      `You tried: ${outcome.description.split('.')[0] || outcome.type}`,
      `Result: ${outcome.success ? 'SUCCESS' : 'FAILED'}${outcome.reason ? ` — ${outcome.reason}` : ''} — ${outcome.description}`,
    ];
    if (outcome.skillXpGained) memoryLines.push(`${outcome.skillXpGained.skill} skill improving.`);
    if (outcome.energySpent > 0) memoryLines.push(`Energy spent: ${outcome.energySpent}. Remaining energy: ${actor.vitals?.energy ?? '?'}.`);
    if (!outcome.success && outcome.remediation) {
      memoryLines.push(`Hint: ${outcome.remediation}`);
    }
    memoryLines.push(`Current inventory: ${invStr}`);

    // Track consecutive failures for importance escalation
    let failureImportance = 6; // default failure importance
    if (!outcome.success) {
      const existing = this.recentFailures.get(actorId);
      const area = this.world.getAreaAt(actor.position)?.id ?? 'unknown';
      if (existing && existing.lastType === outcome.type && existing.lastLocation === area) {
        existing.count++;
        failureImportance = existing.count >= 3 ? 8 : 7;
        const suffix = existing.count === 2 ? 'nd' : existing.count === 3 ? 'rd' : 'th';
        memoryLines.unshift(`WARNING: This is the ${existing.count}${suffix} time this failed here. Try a different approach or location.`);
      } else {
        this.recentFailures.set(actorId, { count: 1, lastType: outcome.type, lastLocation: area });
      }
    } else {
      this.recentFailures.delete(actorId);
    }

    void cognition.addMemory({
      id: crypto.randomUUID(),
      agentId: actorId,
      type: 'action_outcome',
      content: memoryLines.join('\n'),
      importance: outcome.success ? 4 : failureImportance,
      timestamp: Date.now(),
      relatedAgentIds: [],
      actionSuccess: outcome.success,
    });

    // --- Deferred action (compound action handling) ---
    if (outcome.deferredAction) {
      if (outcome.type === 'move') {
        // For moves: store high-importance thought so agent acts on it after arriving
        void cognition.addMemory({
          id: crypto.randomUUID(),
          agentId: actorId,
          type: 'thought',
          content: `After arriving: ${outcome.deferredAction}`,
          importance: 7,
          timestamp: Date.now(),
          relatedAgentIds: [],
        });
      } else {
        // For non-moves: try to execute the deferred action immediately
        const deferredAgentState: ResolverAgentState = {
          id: actorId,
          name: actorName,
          location: this.world.getAreaAt(actor.position)?.id ?? 'unknown',
          energy: actor.vitals?.energy ?? 100,
          hunger: actor.vitals?.hunger ?? 0,
          health: actor.vitals?.health ?? 100,
          inventory: this.buildInventoryForResolver(actor),
          skills: this.buildSkillsForResolver(actor),
          nearbyAgents: this.world.getNearbyAgents(actor.position, 8)
            .filter(a => a.id !== actorId && a.alive !== false)
            .map(a => ({ id: a.id, name: a.config.name })),
        };
        const deferredIntent = parseIntent(outcome.deferredAction, deferredAgentState);
        if (deferredIntent.type !== 'unknown' && deferredIntent.type !== 'intent') {
          const deferredOutcome = executeAction(deferredIntent, deferredAgentState, this.buildWorldStateForResolver());
          deferredOutcome.deferredAction = undefined; // prevent infinite recursion
          this.applyOutcome(actorId, actorName, deferredOutcome, cognition, cognitions, requestConversation);
        } else {
          // Couldn't parse — store as intent thought
          void cognition.addMemory({
            id: crypto.randomUUID(),
            agentId: actorId,
            type: 'thought',
            content: `I still want to: ${outcome.deferredAction}`,
            importance: 6,
            timestamp: Date.now(),
            relatedAgentIds: [],
          });
        }
      }
    }
  }

  /**
   * Execute a single world primitive operation.
   * 6 cases: create, remove, modify, transfer, interact, observe.
   */
  private executeOp(
    actorId: string, actorName: string,
    op: { op: string; [key: string]: any },
    cognition: AgentCognition,
    cognitions?: Map<string, AgentCognition>,
    requestConversation?: (initiatorId: string, targetId: string) => boolean,
  ): void {
    const actor = this.world.getAgent(actorId);
    if (!actor) return;

    switch (op.op) {

      case 'create': {
        const type = op.type;
        const data = op.data || op;

        if (type === 'board_post') {
          // Dedup: skip if agent posted similar content in last 2 game days
          const newContent = (data.content || '').toLowerCase();
          const recentPosts = this.world.board.filter(p =>
            p.authorId === actorId && !p.revoked && (this.world.time.day - p.day) <= 2
          );
          const newWords = new Set(newContent.split(/\s+/).filter((w: string) => w.length > 3));
          const isDuplicate = newWords.size > 0 && recentPosts.some(p => {
            const existingWords = p.content.toLowerCase().split(/\s+/).filter((w: string) => w.length > 3);
            const overlap = existingWords.filter((w: string) => newWords.has(w)).length;
            return overlap / Math.max(newWords.size, 1) > 0.6;
          });
          if (isDuplicate) {
            void cognition.addMemory({
              id: crypto.randomUUID(), agentId: actorId, type: 'observation',
              content: 'I already posted about this on the village board recently.',
              importance: 5, timestamp: Date.now(), relatedAgentIds: [],
            });
            break;
          }

          const post = {
            id: crypto.randomUUID(),
            authorId: actorId, authorName: actorName,
            type: (data.type || 'announcement') as BoardPostType,
            content: data.content || '',
            timestamp: Date.now(), day: this.world.time.day,
            targetIds: data.targetName ? [this.findAgentByName(data.targetName)?.id].filter(Boolean) as string[] : undefined,
          };
          this.world.addBoardPost(post);
          this.broadcaster.boardPost(post);
          this.broadcaster.agentAction(actorId, `posted: "${(data.content || '').slice(0, 60)}"`, '\u{1F4CB}');
        }
        else if (type === 'item') {
          const item: Item = {
            id: crypto.randomUUID(), name: data.name || 'item',
            description: data.description || `${data.name} created by ${actorName}`,
            ownerId: actorId, createdBy: actorId,
            value: data.value || 5, type: data.itemType || 'other',
          };
          this.world.addItem(item);
          this.broadcaster.agentInventory(actorId, actor.inventory);
          this.broadcaster.agentAction(actorId, `created ${item.name}`, '\u{1F528}');
        }
        else if (type === 'artifact') {
          const artifact: Artifact = {
            id: crypto.randomUUID(), title: data.title || 'Untitled',
            content: data.content || '', type: data.artifactType || 'poem',
            creatorId: actorId, creatorName: actorName,
            location: this.world.getAreaAt(actor.position)?.id,
            visibility: data.addressedTo ? 'addressed' as const : (data.artifactType === 'diary' ? 'private' as const : 'public' as const),
            addressedTo: data.addressedTo ? [this.findAgentByName(data.addressedTo)?.id].filter(Boolean) as string[] : [],
            reactions: [], createdAt: Date.now(), day: this.world.time.day,
          };
          this.world.addArtifact(artifact);
          this.broadcaster.artifactCreated(artifact);
          this.broadcaster.agentAction(actorId, `created ${data.artifactType || 'artifact'}: "${data.title}"`, '\u{270D}\uFE0F');
        }
        else if (type === 'building') {
          const materialItem = actor.inventory.find(i => i.type === 'material');
          if (materialItem) {
            this.world.removeItem(materialItem.id);
            const effectsMap: Record<string, string[]> = {
              house: ['shelter'], shop: ['trading'], workshop: ['crafting_bonus'],
              shrine: ['healing'], tavern: ['shelter', 'trading'], barn: ['storage'], wall: ['defense'],
            };
            const building: Building = {
              id: crypto.randomUUID(), name: data.name || 'building',
              type: data.buildingType || 'house',
              description: `${data.name}, built by ${actorName}`,
              ownerId: actorId, areaId: data.location || this.world.getAreaAt(actor.position)?.id || '',
              durability: 100, maxDurability: 100,
              effects: effectsMap[data.buildingType] || [],
              builtBy: actorId, builtAt: Date.now(), materials: [materialItem.name],
            };
            this.world.addBuilding(building);
            this.broadcaster.buildingUpdate(building);
            this.broadcaster.agentAction(actorId, `built ${building.name}`, '\u{1F3D7}\uFE0F');
          }
        }
        else if (type === 'institution') {
          const inst: Institution = {
            id: crypto.randomUUID(), name: data.name || 'organization',
            type: data.instType || 'guild', description: data.description || '',
            founderId: actorId,
            members: [{ agentId: actorId, role: 'founder', joinedAt: Date.now() }],
            treasury: 0, rules: data.rules || [], createdAt: Date.now(),
          };
          this.world.addInstitution(inst);
          this.broadcaster.institutionUpdate(inst);
          this.broadcaster.agentAction(actorId, `founded ${inst.name}`, '\u{1F3DB}\uFE0F');
        }
        else if (type === 'secret') {
          const aboutAgent = data.about ? this.findAgentByName(data.about) : undefined;
          const secret: Secret = {
            id: crypto.randomUUID(), holderId: actorId,
            aboutAgentId: aboutAgent?.id, content: data.content || '',
            importance: data.importance || 7, sharedWith: [] as string[], createdAt: Date.now(),
          };
          this.world.addSecret(secret);
        }
        else if (type === 'election') {
          const election = {
            id: crypto.randomUUID(), position: data.position || 'leader',
            candidates: [actorId], votes: {} as Record<string, string>,
            startDay: this.world.time.day, endDay: this.world.time.day + 2, active: true,
          };
          this.world.startElection(election);
          this.broadcaster.electionUpdate(election);
          this.broadcaster.agentAction(actorId, `called election for ${data.position}`, '\u{1F5F3}\uFE0F');
        }

        void cognition.addMemory({
          id: crypto.randomUUID(), agentId: actorId, type: 'plan',
          content: `I created a ${type}: ${JSON.stringify(data).slice(0, 100)}`,
          importance: 7, timestamp: Date.now(), relatedAgentIds: [],
        });
        break;
      }

      case 'remove': {
        if (op.type === 'item') {
          const item = actor.inventory.find(i =>
            i.name.toLowerCase().includes((op.item || op.name || '').toLowerCase())
          );
          if (item) {
            this.world.removeItem(item.id);
            this.broadcaster.agentInventory(actorId, actor.inventory);
          }
        }
        break;
      }

      case 'modify': {
        const targetName = op.target || 'self';
        const target = targetName === 'self' ? actor : this.findAgentByName(targetName);
        if (!target) break;

        const field = op.field;
        if (field === 'gold' && op.delta) {
          const newBal = this.world.updateAgentCurrency(target.id, op.delta);
          const reason = op.reason || (op.delta > 0 ? 'received gold' : 'spent gold');
          this.broadcaster.agentCurrency(target.id, newBal, op.delta, reason);
        }
        else if (field === 'reputation' && op.delta) {
          if (target.id === actorId) break; // Can't modify your own reputation
          const aboutAgent = op.about ? this.findAgentByName(op.about) : target;
          if (aboutAgent && aboutAgent.id !== actorId) { // Also block rating yourself via "about"
            this.world.updateReputation(target.id, aboutAgent.id, op.delta, op.reason || '');
            this.broadcaster.reputationChange(target.id, aboutAgent.id, this.world.getReputation(target.id, aboutAgent.id));
          }
        }
        else if (field === 'skill') {
          this.world.addSkill(target.id, { name: op.skill || op.value, level: op.level || 1, xp: 0, learnedFrom: actorId });
          const updatedSkill = target.skills.find(s => s.name === (op.skill || op.value));
          if (updatedSkill) this.broadcaster.agentSkill(target.id, updatedSkill);
        }
        else if (field === 'membership') {
          const inst = this.findInstitutionByName(op.institution);
          if (inst && !inst.dissolved) {
            if (op.action === 'leave') {
              this.world.removeInstitutionMember(inst.id, target.id);
            } else {
              this.world.addInstitutionMember(inst.id, { agentId: target.id, role: op.role || 'member', joinedAt: Date.now() });
            }
            this.broadcaster.institutionUpdate(inst);
          }
        }
        else if (field === 'treasury') {
          const inst = this.findInstitutionByName(op.institution);
          if (inst && !inst.dissolved && op.delta) {
            this.world.updateInstitutionTreasury(inst.id, op.delta);
            this.broadcaster.institutionUpdate(inst);
          }
        }
        else if (field === 'property') {
          const areaId = op.area || this.world.getAreaAt(actor.position)?.id;
          if (areaId) {
            const prop = this.world.claimProperty(areaId, target.id, this.world.time.day);
            if (prop) this.broadcaster.propertyChange(prop);
          }
        }
        else if (field === 'vote') {
          const candidate = this.findAgentByName(op.candidate);
          if (candidate) {
            for (const election of this.world.elections.values()) {
              if (election.active && election.position.toLowerCase() === (op.position || '').toLowerCase()) {
                this.world.castVote(election.id, actorId, candidate.id);
                this.broadcaster.electionUpdate(election);
                break;
              }
            }
          }
        }
        break;
      }

      case 'transfer': {
        const what = op.what || 'item';
        const fromName = op.from || 'self';
        const toName = op.to;
        const fromAgent = fromName === 'self' ? actor : this.findAgentByName(fromName);
        const toAgent = toName === 'self' ? actor : this.findAgentByName(toName);
        if (!fromAgent || !toAgent) {
          void cognition.addMemory({
            id: crypto.randomUUID(), agentId: actorId, type: 'observation',
            content: `FAILED: Couldn't find ${!fromAgent ? fromName : toName} nearby to transfer ${op.item || 'gold'}.`,
            importance: 7, timestamp: Date.now(), relatedAgentIds: [],
          });
          break;
        }

        // Block unilateral taking — you can give, but you can't take from others
        if (fromAgent.id !== actorId && toAgent.id === actorId) {
          void cognition.addMemory({
            id: crypto.randomUUID(), agentId: actorId, type: 'observation',
            content: `FAILED: I can't just take things from ${fromAgent.config.name} — I need to negotiate with them in a conversation.`,
            importance: 7, timestamp: Date.now(), relatedAgentIds: [fromAgent.id],
          });
          break;
        }

        if (what === 'gold') {
          const amount = op.amount || 0;
          if (amount > 0) {
            const fromBal = this.world.updateAgentCurrency(fromAgent.id, -amount);
            const toBal = this.world.updateAgentCurrency(toAgent.id, amount);
            this.broadcaster.agentCurrency(fromAgent.id, fromBal, -amount, op.reason || `transferred to ${toAgent.config.name}`);
            this.broadcaster.agentCurrency(toAgent.id, toBal, amount, op.reason || `received from ${fromAgent.config.name}`);
            this.broadcaster.agentAction(actorId, `${fromAgent.id === actorId ? 'gave' : 'took'} ${amount}G ${fromAgent.id === actorId ? 'to' : 'from'} ${toAgent.config.name}`, '\u{1F4B0}');
          }
        }
        else if (what === 'item') {
          const itemName = (op.item || '').toLowerCase();
          const item = fromAgent.inventory.find(i => i.name.toLowerCase().includes(itemName));
          if (item) {
            this.world.transferItem(item.id, fromAgent.id, toAgent.id);
            // Check if transfer silently failed (receiver inventory full)
            const stillHasItem = fromAgent.inventory.some(i => i.id === item.id);
            if (stillHasItem) {
              void cognition.addMemory({
                id: crypto.randomUUID(), agentId: actorId, type: 'observation',
                content: `FAILED: I tried to give ${item.name} to ${toAgent.config.name} but they can't carry any more items.`,
                importance: 7, timestamp: Date.now(), relatedAgentIds: [toAgent.id],
              });
              break;
            }
            this.broadcaster.agentInventory(fromAgent.id, fromAgent.inventory);
            this.broadcaster.agentInventory(toAgent.id, toAgent.inventory);
            this.broadcaster.agentAction(actorId, `transferred ${item.name} to ${toAgent.config.name}`, '\u{1F4E6}');
          } else {
            void cognition.addMemory({
              id: crypto.randomUUID(), agentId: actorId, type: 'observation',
              content: `FAILED: I don't have ${op.item || 'that item'} in my inventory.`,
              importance: 7, timestamp: Date.now(), relatedAgentIds: [],
            });
          }
        }

        // Store memory for recipient (only on successful transfer)
        const recipientCog = cognitions?.get(toAgent.id);
        if (recipientCog) {
          void recipientCog.addMemory({
            id: crypto.randomUUID(), agentId: toAgent.id, type: 'observation',
            content: `${fromAgent.config.name} ${what === 'gold' ? `gave me ${op.amount} gold` : `gave me ${op.item}`}`,
            importance: 7, timestamp: Date.now(), relatedAgentIds: [fromAgent.id],
          }).catch(() => {});
        }
        break;
      }

      case 'interact': {
        if (!requestConversation) break;
        let target: Agent | undefined;
        const who = op.target || op.who;
        if (!who || who === 'anyone' || who === 'anyone nearby') {
          const nearbyAgents = this.world.getNearbyAgents(actor.position, 10)
            .filter(a => a.id !== actorId && a.alive !== false);
          target = nearbyAgents[0];
        } else {
          target = this.findAgentByName(who);
        }
        if (target) {
          const started = requestConversation(actorId, target.id);
          if (!started) {
            void cognition.addMemory({
              id: crypto.randomUUID(), agentId: actorId, type: 'observation',
              content: `FAILED: I tried to talk to ${target.config.name} but they were busy or unavailable.`,
              importance: 7, timestamp: Date.now(), relatedAgentIds: [target.id],
            });
          }
        } else {
          void cognition.addMemory({
            id: crypto.randomUUID(), agentId: actorId, type: 'observation',
            content: 'FAILED: I wanted to talk to someone but nobody was around.',
            importance: 6, timestamp: Date.now(), relatedAgentIds: [],
          });
        }
        break;
      }

      case 'observe': {
        const observation = op.observation || op.content || 'Observed surroundings.';
        void cognition.addMemory({
          id: crypto.randomUUID(), agentId: actorId, type: 'observation',
          content: observation, importance: 5, timestamp: Date.now(), relatedAgentIds: [],
        });
        this.broadcaster.agentAction(actorId, observation.slice(0, 80), '\u{1F441}\uFE0F');
        break;
      }

      default: {
        void cognition.addMemory({
          id: crypto.randomUUID(), agentId: actorId, type: 'observation',
          content: `I tried to ${op.op}: ${JSON.stringify(op)}`,
          importance: 4, timestamp: Date.now(), relatedAgentIds: [],
        });
        break;
      }
    }
  }

  /**
   * Build institution context for a specific agent.
   */
  private buildInstitutionContext(agentId: string): string {
    const institutions = Array.from(this.world.institutions.values()).filter(i => !i.dissolved);
    if (institutions.length === 0) return '';

    const lines: string[] = ['VILLAGE INSTITUTIONS:'];
    for (const inst of institutions) {
      const myMembership = inst.members.find(m => m.agentId === agentId);
      const memberNames = inst.members
        .map(m => this.world.getAgent(m.agentId)?.config.name ?? m.agentId.slice(0, 6))
        .join(', ');
      let line = `- ${inst.name} (${inst.type}): ${inst.description || 'no description'}. ${inst.members.length} members [${memberNames}]. Treasury: ${inst.treasury}g.`;
      if (myMembership) {
        line += ` YOU are a ${myMembership.role}.`;
      }
      lines.push(line);
    }
    return lines.join('\n');
  }

  /**
   * Find an agent by name (case-insensitive, partial match).
   */
  private findAgentByName(name: string): import('@ai-village/shared').Agent | undefined {
    const lower = name.toLowerCase().trim();
    for (const agent of this.world.agents.values()) {
      const agentName = agent.config.name.toLowerCase();
      if (
        agentName === lower ||
        agentName.includes(lower) ||
        lower.includes(agentName.split(' ')[0].toLowerCase())
      ) {
        return agent;
      }
    }
    return undefined;
  }

  /**
   * Find an institution by name (case-insensitive, partial match).
   */
  private findInstitutionByName(name: string): Institution | undefined {
    const lower = name.toLowerCase().trim();
    for (const inst of this.world.institutions.values()) {
      const instName = inst.name.toLowerCase();
      if (
        instName === lower ||
        instName.includes(lower) ||
        lower.includes(instName)
      ) {
        return inst;
      }
    }
    return undefined;
  }
}
