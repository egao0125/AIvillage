import type { BoardPostType, Conversation, Item, Memory, Position, Secret, Artifact, Building, Institution, Agent } from '@ai-village/shared';
import type { AgentCognition } from '@ai-village/ai-engine';
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

  constructor(
    private world: World,
    private broadcaster: EventBroadcaster,
  ) {}

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
    const maxTurns = 20;

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

      let response: string;
      try {
        response = await cognition.talk(otherAgents, history, boardContext, institutionContext || undefined, artifactContext, secretsContext, agenda);
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
        this.executeSocialAction(speakerId, speakerAgent.config.name, defaultTargetId, actionIntent, cognition, cognitions);
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
        } catch (err) {
          console.error(`[Memory] Failed to store commitment for ${participant.config.name}:`, err);
        }
      }
    }
  }

  /**
   * Parse and execute a social action from an agent's conversation or think() output.
   * Uses LLM resolver to break freeform actions into 6 world primitives.
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
    const nearby = this.world.getNearbyAgents(actor.position, 8)
      .filter(a => a.id !== actorId && a.alive !== false)
      .map(a => a.config.name);

    let ops: { op: string; [key: string]: any }[];
    try {
      ops = await cognition.resolveAction(rawAction, {
        location: area?.id ?? 'unknown',
        nearbyAgents: nearby,
        inventory: actor.inventory.map(i => `${i.name} (${i.type})`),
        gold: actor.currency,
      });
    } catch (err) {
      console.error(`[Social] Resolve failed for ${actorName}:`, err);
      ops = [{ op: 'observe', observation: rawAction }];
    }

    for (const op of ops) {
      this.executeOp(actorId, actorName, op, cognition, cognitions, requestConversation);
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
          const aboutAgent = op.about ? this.findAgentByName(op.about) : target;
          if (aboutAgent) {
            this.world.updateReputation(target.id, aboutAgent.id, op.delta, op.reason || '');
            this.broadcaster.reputationChange(target.id, aboutAgent.id, this.world.getReputation(target.id, aboutAgent.id));
          }
        }
        else if (field === 'skill') {
          this.world.addSkill(target.id, { name: op.skill || op.value, level: op.level || 1, learnedFrom: actorId });
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
          const prop = this.world.claimProperty(op.area, target.id, this.world.time.day);
          if (prop) this.broadcaster.propertyChange(prop);
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
            content: `Couldn't find ${!fromAgent ? fromName : toName} to complete the transfer.`,
            importance: 5, timestamp: Date.now(), relatedAgentIds: [],
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
            this.broadcaster.agentInventory(fromAgent.id, fromAgent.inventory);
            this.broadcaster.agentInventory(toAgent.id, toAgent.inventory);
            this.broadcaster.agentAction(actorId, `transferred ${item.name} to ${toAgent.config.name}`, '\u{1F4E6}');
          } else {
            void cognition.addMemory({
              id: crypto.randomUUID(), agentId: actorId, type: 'observation',
              content: `I tried to transfer ${op.item} but couldn't find it.`,
              importance: 5, timestamp: Date.now(), relatedAgentIds: [],
            });
          }
        }

        // Store memory for recipient
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
              content: `I tried to talk to ${target.config.name} but they were busy.`,
              importance: 5, timestamp: Date.now(), relatedAgentIds: [target.id],
            });
          }
        } else {
          void cognition.addMemory({
            id: crypto.randomUUID(), agentId: actorId, type: 'observation',
            content: 'I wanted to talk to someone but nobody was around.',
            importance: 4, timestamp: Date.now(), relatedAgentIds: [],
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
