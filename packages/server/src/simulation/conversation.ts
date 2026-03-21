import type { BoardPostType, Conversation, Item, Memory, Position, Secret, Artifact, ArtifactReaction, Building, Institution, InstitutionMember, Agent } from '@ai-village/shared';
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

      let response: string;
      try {
        response = await cognition.converse(otherAgents, history, boardContext, institutionContext || undefined, artifactContext, secretsContext);
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

      // Store the full conversation as a memory
      const memory: Memory = {
        id: crypto.randomUUID(),
        agentId: participantId,
        type: 'conversation',
        content: `I had a conversation with ${othersLabel}. Here's what was said:\n${transcript}`,
        importance: 6,
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
  }

  /**
   * Parse and execute a social action from an agent's conversation.
   * Actions can affect the world state: post to the board, transfer currency, etc.
   */
  executeSocialAction(
    actorId: string,
    actorName: string,
    targetId: string,
    rawAction: string,
    cognition: AgentCognition,
    cognitions?: Map<string, AgentCognition>,
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
      // Mid-day mood reaction on gift recipient
      const giftRecipientCog = cognitions?.get(targetId);
      const giftTarget = this.world.getAgent(targetId);
      if (giftRecipientCog && giftTarget) {
        void giftRecipientCog.quickMoodReaction(`${actorName} gave me ${amount} gold as a gift!`).then(mood => {
          if (mood) { giftTarget.mood = mood; this.broadcaster.agentMood(targetId, mood); }
        }).catch(() => {});
      }
      console.log(`[Social] ${actorName} gave ${amount}G to ${this.world.getAgent(targetId)?.config.name}`);
      return;
    }

    // Instant theft — victim has no say (50% fail chance via steal item pattern)
    const goldStealMatch = lower.match(/(?:take|steal|tax)\s+(\d+)\s*(?:gold|coins?|g)\s+from\s+(\w+)/);
    if (goldStealMatch) {
      const amount = parseInt(goldStealMatch[1]);
      const target = this.world.getAgent(targetId);
      if (target) {
        const taken = Math.min(amount, target.currency);
        if (taken > 0) {
          const targetBalance = this.world.updateAgentCurrency(targetId, -taken);
          const actorBalance = this.world.updateAgentCurrency(actorId, taken);
          this.broadcaster.agentCurrency(targetId, targetBalance, -taken, `${actorName} took gold`);
          this.broadcaster.agentCurrency(actorId, actorBalance, taken, `took gold from ${target.config.name}`);
          console.log(`[Social] ${actorName} took ${taken}G from ${target.config.name}`);

          // Mid-day mood reaction on victim
          const victimCognition = cognitions?.get(targetId);
          if (victimCognition) {
            void victimCognition.quickMoodReaction(`${actorName} stole ${taken} gold from me!`).then(mood => {
              if (mood) {
                target.mood = mood;
                this.broadcaster.agentMood(targetId, mood);
              }
            }).catch(() => {});
          }
        }
      }
      return;
    }

    // Victim-agency demands — stored as memory, victim decides
    const goldDemandMatch = lower.match(/(?:demand|extort)\s+(\d+)\s*(?:gold|coins?|g)\s+from\s+(\w+)/);
    if (goldDemandMatch) {
      const amount = parseInt(goldDemandMatch[1]);
      const target = this.world.getAgent(targetId);
      if (target) {
        // Store demand as high-importance memory on victim — they'll decide during next action
        const victimCognition = cognitions?.get(targetId);
        if (victimCognition) {
          void victimCognition.addMemory({
            id: crypto.randomUUID(),
            agentId: targetId,
            type: 'observation',
            content: `${actorName} demanded ${amount} gold from me. I need to decide whether to comply or resist.`,
            importance: 9,
            timestamp: Date.now(),
            relatedAgentIds: [actorId],
          });

          // Mid-day mood reaction on victim
          void victimCognition.quickMoodReaction(`${actorName} demanded ${amount} gold from me!`).then(mood => {
            if (mood) {
              target.mood = mood;
              this.broadcaster.agentMood(targetId, mood);
            }
          }).catch(() => {});
        }
        // Broadcast the demand (everyone sees it happened)
        this.broadcaster.agentAction(actorId, `demanded ${amount}G from ${target.config.name}`, '💰');
        console.log(`[Social] ${actorName} demanded ${amount}G from ${target.config.name} — victim will decide`);
      }
      return;
    }

    // --- GATHER MATERIAL ---
    // e.g. "gather - wood"
    const gatherMatch = lower.match(/^gather\s*[-:]\s*(.+)/);
    if (gatherMatch) {
      const material = gatherMatch[1].trim();
      const actor = this.world.getAgent(actorId);
      if (actor) {
        const area = this.world.getAreaAt(actor.position);
        const areaId = area?.id ?? '';
        const item = this.world.gatherMaterial(actorId, areaId);
        if (item) {
          this.broadcaster.agentInventory(actorId, actor.inventory);
          this.broadcaster.agentAction(actorId, `gathered ${material}`, '🪓');
        } else {
          console.log(`[Social] ${actorName} tried to gather ${material} but nothing available`);
        }
      }
      return;
    }

    // --- CRAFT ITEM ---
    // e.g. "craft - wooden chair from wood"
    const craftMatch = lower.match(/^craft\s*[-:]\s*(.+?)\s+from\s+(.+)/);
    if (craftMatch) {
      const itemName = craftMatch[1].trim();
      const materialName = craftMatch[2].trim();
      const actor = this.world.getAgent(actorId);
      if (actor) {
        const materialItem = actor.inventory.find(i => i.name.toLowerCase() === materialName && i.type === 'material');
        if (materialItem) {
          this.world.removeItem(materialItem.id);
          // Skill multiplier: crafting-related skills boost value
          const craftSkill = actor.skills.find(s => s.name.toLowerCase().includes('craft') || s.name.toLowerCase().includes(materialName));
          const skillMultiplier = craftSkill ? 1 + craftSkill.level * 0.1 : 1.0;
          // Building crafting_bonus: check for workshop-type building at current location
          const actorArea = this.world.getAreaAt(actor.position);
          let buildingMultiplier = 1.0;
          if (actorArea) {
            for (const building of this.world.buildings.values()) {
              if (building.areaId === actorArea.id && building.effects.includes('crafting_bonus') && building.durability > 0) {
                buildingMultiplier = 1.5;
                break;
              }
            }
          }
          const craftedItem: Item = {
            id: crypto.randomUUID(),
            name: itemName,
            description: `${itemName} crafted by ${actorName} from ${materialName}`,
            ownerId: actorId,
            createdBy: actorId,
            value: Math.floor(materialItem.value * 2 * skillMultiplier * buildingMultiplier),
            type: 'other',
          };
          this.world.addItem(craftedItem);
          this.broadcaster.agentInventory(actorId, actor.inventory);
          this.broadcaster.agentAction(actorId, `crafted ${itemName}`, '🔨');
          console.log(`[Social] ${actorName} crafted ${itemName} from ${materialName} (skill: x${skillMultiplier.toFixed(1)}, building: x${buildingMultiplier})`);
        } else {
          console.log(`[Social] ${actorName} tried to craft ${itemName} but lacks ${materialName}`);
        }
      }
      return;
    }

    // --- COOK FOOD ---
    // e.g. "cook - mushroom soup from mushrooms"
    const cookMatch = lower.match(/^cook\s*[-:]\s*(.+?)\s+from\s+(.+)/);
    if (cookMatch) {
      const dishName = cookMatch[1].trim();
      const ingredientName = cookMatch[2].trim();
      const actor = this.world.getAgent(actorId);
      if (actor) {
        const ingredient = actor.inventory.find(i =>
          i.name.toLowerCase() === ingredientName && (i.type === 'material' || i.type === 'food')
        );
        if (ingredient) {
          this.world.removeItem(ingredient.id);
          // Skill multiplier: cooking-related skills boost value
          const cookSkill = actor.skills.find(s => s.name.toLowerCase().includes('cook') || s.name.toLowerCase().includes('chef'));
          const cookSkillMult = cookSkill ? 1 + cookSkill.level * 0.1 : 1.0;
          // Building crafting_bonus: check for workshop/kitchen building at current location
          const cookArea = this.world.getAreaAt(actor.position);
          let cookBuildingMult = 1.0;
          if (cookArea) {
            for (const building of this.world.buildings.values()) {
              if (building.areaId === cookArea.id && building.effects.includes('crafting_bonus') && building.durability > 0) {
                cookBuildingMult = 1.5;
                break;
              }
            }
          }
          const cookedItem: Item = {
            id: crypto.randomUUID(),
            name: dishName,
            description: `${dishName} cooked by ${actorName} from ${ingredientName}`,
            ownerId: actorId,
            createdBy: actorId,
            value: Math.floor(ingredient.value * 2 * cookSkillMult * cookBuildingMult),
            type: 'food',
          };
          this.world.addItem(cookedItem);
          this.broadcaster.agentInventory(actorId, actor.inventory);
          this.broadcaster.agentAction(actorId, `cooked ${dishName}`, '\u{1F373}');
          console.log(`[Social] ${actorName} cooked ${dishName} from ${ingredientName}`);
        } else {
          console.log(`[Social] ${actorName} tried to cook ${dishName} but lacks ${ingredientName}`);
        }
      }
      return;
    }

    // --- GIVE ITEM ---
    // e.g. "give item - wooden chair to Yuki"
    const giveItemMatch = lower.match(/^give\s+item\s*[-:]\s*(.+?)\s+to\s+(.+)/);
    if (giveItemMatch) {
      const itemName = giveItemMatch[1].trim();
      const recipientName = giveItemMatch[2].trim();
      const actor = this.world.getAgent(actorId);
      if (actor) {
        const item = actor.inventory.find(i => i.name.toLowerCase() === itemName);
        const recipient = this.findAgentByName(recipientName);
        if (item && recipient) {
          this.world.transferItem(item.id, actorId, recipient.id);
          this.broadcaster.agentInventory(actorId, actor.inventory);
          this.broadcaster.agentInventory(recipient.id, recipient.inventory);
          console.log(`[Social] ${actorName} gave ${itemName} to ${recipient.config.name}`);
        }
      }
      return;
    }

    // --- SELL ITEM ---
    // e.g. "sell item - wooden chair to Yuki for 20 gold"
    const sellItemMatch = lower.match(/^sell\s+item\s*[-:]\s*(.+?)\s+to\s+(.+?)\s+for\s+(\d+)\s*(?:gold|coins?|g)/);
    if (sellItemMatch) {
      const itemName = sellItemMatch[1].trim();
      const buyerName = sellItemMatch[2].trim();
      const price = parseInt(sellItemMatch[3]);
      const actor = this.world.getAgent(actorId);
      if (actor) {
        const item = actor.inventory.find(i => i.name.toLowerCase() === itemName);
        const buyer = this.findAgentByName(buyerName);
        if (item && buyer && buyer.currency >= price) {
          this.world.transferItem(item.id, actorId, buyer.id);
          const buyerBalance = this.world.updateAgentCurrency(buyer.id, -price);
          const sellerBalance = this.world.updateAgentCurrency(actorId, price);
          this.broadcaster.agentCurrency(buyer.id, buyerBalance, -price, `bought ${itemName} from ${actorName}`);
          this.broadcaster.agentCurrency(actorId, sellerBalance, price, `sold ${itemName} to ${buyer.config.name}`);
          this.broadcaster.agentInventory(actorId, actor.inventory);
          this.broadcaster.agentInventory(buyer.id, buyer.inventory);
          console.log(`[Social] ${actorName} sold ${itemName} to ${buyer.config.name} for ${price}G`);
        }
      }
      return;
    }

    // --- BUY ITEM ---
    // e.g. "buy item - wooden chair from Yuki for 20 gold"
    const buyItemMatch = lower.match(/^buy\s+item\s*[-:]\s*(.+?)\s+from\s+(.+?)\s+for\s+(\d+)\s*(?:gold|coins?|g)/);
    if (buyItemMatch) {
      const itemName = buyItemMatch[1].trim();
      const sellerName = buyItemMatch[2].trim();
      const price = parseInt(buyItemMatch[3]);
      const actor = this.world.getAgent(actorId);
      if (actor) {
        const seller = this.findAgentByName(sellerName);
        if (seller && actor.currency >= price) {
          const item = seller.inventory.find(i => i.name.toLowerCase() === itemName);
          if (item) {
            this.world.transferItem(item.id, seller.id, actorId);
            const actorBalance = this.world.updateAgentCurrency(actorId, -price);
            const sellerBalance = this.world.updateAgentCurrency(seller.id, price);
            this.broadcaster.agentCurrency(actorId, actorBalance, -price, `bought ${itemName} from ${seller.config.name}`);
            this.broadcaster.agentCurrency(seller.id, sellerBalance, price, `sold ${itemName} to ${actorName}`);
            this.broadcaster.agentInventory(actorId, actor.inventory);
            this.broadcaster.agentInventory(seller.id, seller.inventory);
            console.log(`[Social] ${actorName} bought ${itemName} from ${seller.config.name} for ${price}G`);
          }
        }
      }
      return;
    }

    // --- STEAL ITEM ---
    // e.g. "steal item - wooden chair from Yuki"
    const stealItemMatch = lower.match(/^steal\s+item\s*[-:]\s*(.+?)\s+from\s+(.+)/);
    if (stealItemMatch) {
      const itemName = stealItemMatch[1].trim();
      const victimName = stealItemMatch[2].trim();
      const actor = this.world.getAgent(actorId);
      if (actor) {
        const victim = this.findAgentByName(victimName);
        if (victim) {
          const item = victim.inventory.find(i => i.name.toLowerCase() === itemName);
          // 50% chance of success
          if (item && Math.random() < 0.5) {
            this.world.transferItem(item.id, victim.id, actorId);
            this.broadcaster.agentInventory(actorId, actor.inventory);
            this.broadcaster.agentInventory(victim.id, victim.inventory);
            this.world.updateReputation(victim.id, actorId, -20, `stole ${itemName}`);
            this.broadcaster.reputationChange(victim.id, actorId, this.world.getReputation(victim.id, actorId));
            console.log(`[Social] ${actorName} stole ${itemName} from ${victim.config.name}!`);
          } else {
            this.world.updateReputation(victim.id, actorId, -10, `attempted theft of ${itemName}`);
            this.broadcaster.reputationChange(victim.id, actorId, this.world.getReputation(victim.id, actorId));
            console.log(`[Social] ${actorName} failed to steal ${itemName} from ${victim?.config.name ?? victimName}`);
          }

          // Witness detection: nearby agents see the theft attempt
          const nearbyWitnesses = this.world.getNearbyAgents(actor!.position, 5)
            .filter(a => a.id !== actorId && a.id !== victim!.id && a.alive !== false);
          for (const witness of nearbyWitnesses) {
            const witnessSecret: Secret = {
              id: crypto.randomUUID(),
              holderId: witness.id,
              aboutAgentId: actorId,
              content: `I saw ${actorName} try to steal ${itemName} from ${victim!.config.name}`,
              importance: 8,
              sharedWith: [],
              createdAt: Date.now(),
            };
            this.world.addSecret(witnessSecret);
            console.log(`[Social] ${witness.config.name} witnessed theft attempt by ${actorName}`);
          }
        }
      }
      return;
    }

    // --- SHARE SECRET ---
    // e.g. "share secret - the mayor is corrupt with Yuki"
    const shareSecretMatch = lower.match(/^share\s+secret\s*[-:]\s*(.+?)\s+with\s+(.+)/);
    if (shareSecretMatch) {
      const secretText = shareSecretMatch[1].trim();
      const recipientName = shareSecretMatch[2].trim();
      const recipient = this.findAgentByName(recipientName);
      if (recipient) {
        // Find existing secret or create one
        let secret = this.world.secrets.find(s => s.holderId === actorId && s.content.toLowerCase() === secretText);
        if (!secret) {
          secret = {
            id: crypto.randomUUID(),
            holderId: actorId,
            content: secretText,
            importance: 7,
            sharedWith: [],
            createdAt: Date.now(),
          };
          this.world.addSecret(secret);
        }
        if (!secret.sharedWith.includes(recipient.id)) {
          secret.sharedWith.push(recipient.id);
        }
        this.broadcaster.secretShared(actorId, recipient.id);
        this.world.updateReputation(recipient.id, actorId, 5, 'shared a secret');

        // Gossip propagation: sharer's opinion of the secret's subject influences listener
        if (secret.aboutAgentId) {
          const sharerRep = this.world.getReputation(actorId, secret.aboutAgentId);
          const attenuated = Math.max(-15, Math.min(15, Math.round(sharerRep * 0.5)));
          const listenerRep = this.world.getReputation(recipient.id, secret.aboutAgentId);
          if (Math.abs(listenerRep) < 30 && attenuated !== 0) {
            this.world.updateReputation(recipient.id, secret.aboutAgentId, attenuated, `heard gossip from ${actorName}`);
            this.broadcaster.reputationChange(recipient.id, secret.aboutAgentId, this.world.getReputation(recipient.id, secret.aboutAgentId));
          }
        }

        console.log(`[Social] ${actorName} shared a secret with ${recipient.config.name}: "${secretText}"`);
      }
      return;
    }

    // --- CREATE SECRET ---
    // e.g. "create secret - saw them stealing about Yuki"
    const createSecretMatch = lower.match(/^create\s+secret\s*[-:]\s*(.+?)\s+about\s+(.+)/);
    if (createSecretMatch) {
      const secretText = createSecretMatch[1].trim();
      const aboutName = createSecretMatch[2].trim();
      const aboutAgent = this.findAgentByName(aboutName);
      const secret: Secret = {
        id: crypto.randomUUID(),
        holderId: actorId,
        aboutAgentId: aboutAgent?.id,
        content: secretText,
        importance: 7,
        sharedWith: [],
        createdAt: Date.now(),
      };
      this.world.addSecret(secret);
      console.log(`[Social] ${actorName} created a secret about ${aboutName}: "${secretText}"`);
      return;
    }

    // --- BLACKMAIL ---
    // e.g. "blackmail - Yuki with I saw you steal from the bakery"
    const blackmailMatch = lower.match(/^blackmail\s*[-:]\s*(.+?)\s+with\s+(.+)/);
    if (blackmailMatch) {
      const targetName = blackmailMatch[1].trim();
      const secretText = blackmailMatch[2].trim();
      const target = this.findAgentByName(targetName);
      if (target) {
        // Validate actor holds a secret about target
        const heldSecret = this.world.secrets.find(s =>
          s.holderId === actorId && s.aboutAgentId === target.id
        );
        if (heldSecret) {
          // 40% chance target pays, 60% chance they refuse
          if (Math.random() < 0.4) {
            // Target pays — 10-30 gold
            const amount = 10 + Math.floor(Math.random() * 21);
            const taken = Math.min(amount, target.currency);
            if (taken > 0) {
              const targetBalance = this.world.updateAgentCurrency(target.id, -taken);
              const actorBalance = this.world.updateAgentCurrency(actorId, taken);
              this.broadcaster.agentCurrency(target.id, targetBalance, -taken, `blackmailed by ${actorName}`);
              this.broadcaster.agentCurrency(actorId, actorBalance, taken, `blackmailed ${target.config.name}`);
            }
            this.world.updateReputation(target.id, actorId, -15, `blackmailed me`);
            this.broadcaster.reputationChange(target.id, actorId, this.world.getReputation(target.id, actorId));
            // Mid-day mood reaction on blackmail victim
            const victimCog = cognitions?.get(target.id);
            if (victimCog) {
              void victimCog.quickMoodReaction(`${actorName} blackmailed me and I had to pay ${taken} gold!`).then(mood => {
                if (mood) { target.mood = mood; this.broadcaster.agentMood(target.id, mood); }
              }).catch(() => {});
            }
            console.log(`[Social] ${actorName} blackmailed ${target.config.name} for ${taken}G`);
          } else {
            // Target refuses — secret gets exposed as board rumor
            this.world.addBoardPost({
              id: crypto.randomUUID(),
              authorId: target.id,
              authorName: target.config.name,
              type: 'rumor',
              content: `${actorName} tried to blackmail me! They claimed: "${secretText}"`,
              timestamp: Date.now(),
              day: this.world.time.day,
              targetIds: [actorId],
            });
            this.broadcaster.boardPost(this.world.board[this.world.board.length - 1]);
            // Village-wide rep hit for blackmailer
            for (const agent of this.world.agents.values()) {
              if (agent.id !== actorId && agent.alive !== false) {
                this.world.updateReputation(agent.id, actorId, -5, `attempted blackmail against ${target.config.name}`);
              }
            }
            this.world.updateReputation(target.id, actorId, -25, `tried to blackmail me`);
            this.broadcaster.reputationChange(target.id, actorId, this.world.getReputation(target.id, actorId));
            // Mid-day mood reaction on blackmail victim (refused — may feel angry/empowered)
            const refusedVictimCog = cognitions?.get(target.id);
            if (refusedVictimCog) {
              void refusedVictimCog.quickMoodReaction(`${actorName} tried to blackmail me but I refused and exposed them!`).then(mood => {
                if (mood) { target.mood = mood; this.broadcaster.agentMood(target.id, mood); }
              }).catch(() => {});
            }
            console.log(`[Social] ${actorName} failed to blackmail ${target.config.name} — secret exposed!`);
          }
        } else {
          console.log(`[Social] ${actorName} tried to blackmail ${target.config.name} but holds no secret about them`);
        }
      }
      return;
    }

    // --- PROPOSE INVENTION ---
    // e.g. "propose invention - Water Wheel: uses river current for power using wood"
    const inventionMatch = lower.match(/^propose\s+invention\s*[-:]\s*(.+?):\s*(.+?)\s+using\s+(.+)/);
    if (inventionMatch) {
      const invName = inventionMatch[1].trim();
      const invDescription = inventionMatch[2].trim();
      const invMaterials = inventionMatch[3].trim();
      const actor = this.world.getAgent(actorId);
      if (actor) {
        // Check actor has at least one of the named materials
        const materialItem = actor.inventory.find(i =>
          i.type === 'material' && invMaterials.toLowerCase().includes(i.name.toLowerCase())
        );
        if (materialItem && !this.world.hasTechnology(invName)) {
          this.world.removeItem(materialItem.id);
          const tech: import('@ai-village/shared').Technology = {
            id: crypto.randomUUID(),
            name: invName,
            description: invDescription,
            inventorId: actorId,
            inventorName: actorName,
            effects: [invDescription],
            requirements: [invMaterials],
            discoveredAt: Date.now(),
            day: this.world.time.day,
          };
          this.world.addTechnology(tech);
          this.broadcaster.boardPost({
            id: crypto.randomUUID(),
            authorId: actorId,
            authorName: actorName,
            type: 'announcement',
            content: `${actorName} invented "${invName}": ${invDescription}`,
            timestamp: Date.now(),
            day: this.world.time.day,
          });
          this.broadcaster.agentInventory(actorId, actor.inventory);
          void cognition.addMemory({
            id: crypto.randomUUID(),
            agentId: actorId,
            type: 'plan',
            content: `I invented "${invName}": ${invDescription}`,
            importance: 9,
            timestamp: Date.now(),
            relatedAgentIds: [],
          });
          console.log(`[Tech] ${actorName} invented: ${invName}`);
        } else {
          console.log(`[Social] ${actorName} tried to invent ${invName} but lacks materials or already exists`);
        }
      }
      return;
    }

    // --- CALL ELECTION ---
    // e.g. "call election - mayor"
    const electionMatch = lower.match(/^call\s+election\s*[-:]\s*(.+)/);
    if (electionMatch) {
      const position = electionMatch[1].trim();
      const election = {
        id: crypto.randomUUID(),
        position,
        candidates: [actorId],
        votes: {} as Record<string, string>,
        startDay: this.world.time.day,
        endDay: this.world.time.day + 2,
        active: true,
      };
      this.world.startElection(election);
      this.broadcaster.electionUpdate(election);
      console.log(`[Social] ${actorName} called an election for ${position}`);
      return;
    }

    // --- VOTE ---
    // e.g. "vote - Yuki for mayor"
    const voteMatch = lower.match(/^vote\s*[-:]\s*(.+?)\s+for\s+(.+)/);
    if (voteMatch) {
      const candidateName = voteMatch[1].trim();
      const position = voteMatch[2].trim();
      const candidate = this.findAgentByName(candidateName);
      if (candidate) {
        // Find active election for this position
        for (const election of this.world.elections.values()) {
          if (election.active && election.position.toLowerCase() === position) {
            this.world.castVote(election.id, actorId, candidate.id);
            this.broadcaster.electionUpdate(election);
            console.log(`[Social] ${actorName} voted for ${candidate.config.name} for ${position}`);
            break;
          }
        }
      }
      return;
    }

    // --- CLAIM PROPERTY ---
    // e.g. "claim property - forest"
    const claimMatch = lower.match(/^claim\s+property\s*[-:]\s*(.+)/);
    if (claimMatch) {
      const areaName = claimMatch[1].trim();
      const property = this.world.claimProperty(areaName, actorId, this.world.time.day);
      if (property) {
        this.broadcaster.propertyChange(property);
        console.log(`[Social] ${actorName} claimed ${areaName}`);
      } else {
        console.log(`[Social] ${actorName} tried to claim ${areaName} but it's already owned`);
      }
      return;
    }

    // --- CHARGE RENT ---
    // e.g. "charge rent - 10 gold for forest"
    const rentMatch = lower.match(/^charge\s+rent\s*[-:]\s*(\d+)\s*(?:gold|coins?|g)\s+for\s+(.+)/);
    if (rentMatch) {
      const amount = parseInt(rentMatch[1]);
      const areaName = rentMatch[2].trim();
      const ownerId = this.world.getPropertyOwner(areaName);
      if (ownerId === actorId) {
        // Charge all agents currently at that area
        for (const agent of this.world.agents.values()) {
          if (agent.id === actorId) continue;
          const agentArea = this.world.getAreaAt(agent.position);
          if (agentArea?.id === areaName) {
            const paid = Math.min(amount, agent.currency);
            if (paid > 0) {
              const tenantBalance = this.world.updateAgentCurrency(agent.id, -paid);
              const ownerBalance = this.world.updateAgentCurrency(actorId, paid);
              this.broadcaster.agentCurrency(agent.id, tenantBalance, -paid, `rent to ${actorName} for ${areaName}`);
              this.broadcaster.agentCurrency(actorId, ownerBalance, paid, `rent from ${agent.config.name} for ${areaName}`);
              console.log(`[Social] ${actorName} charged ${agent.config.name} ${paid}G rent for ${areaName}`);
            }
          }
        }
      }
      return;
    }

    // --- TEACH SKILL ---
    // e.g. "teach - cooking to Yuki"
    const teachMatch = lower.match(/^teach\s*[-:]\s*(.+?)\s+to\s+(.+)/);
    if (teachMatch) {
      const skillName = teachMatch[1].trim();
      const studentName = teachMatch[2].trim();
      const student = this.findAgentByName(studentName);
      if (student) {
        this.world.addSkill(student.id, { name: skillName, level: 1, learnedFrom: actorId });
        const updatedSkill = student.skills.find(s => s.name === skillName);
        if (updatedSkill) {
          this.broadcaster.agentSkill(student.id, updatedSkill);
        }
        this.world.updateReputation(student.id, actorId, 10, `taught ${skillName}`);
        this.broadcaster.reputationChange(student.id, actorId, this.world.getReputation(student.id, actorId));
        console.log(`[Social] ${actorName} taught ${skillName} to ${student.config.name}`);
      }
      return;
    }

    // --- LEARN SKILL ---
    // e.g. "learn - cooking from Yuki"
    const learnMatch = lower.match(/^learn\s*[-:]\s*(.+?)\s+from\s+(.+)/);
    if (learnMatch) {
      const skillName = learnMatch[1].trim();
      const teacherName = learnMatch[2].trim();
      const teacher = this.findAgentByName(teacherName);
      if (teacher) {
        this.world.addSkill(actorId, { name: skillName, level: 1, learnedFrom: teacher.id });
        const actor = this.world.getAgent(actorId);
        if (actor) {
          const updatedSkill = actor.skills.find(s => s.name === skillName);
          if (updatedSkill) {
            this.broadcaster.agentSkill(actorId, updatedSkill);
          }
        }
        this.world.updateReputation(actorId, teacher.id, 5, `learned ${skillName}`);
        this.broadcaster.reputationChange(actorId, teacher.id, this.world.getReputation(actorId, teacher.id));
        console.log(`[Social] ${actorName} learned ${skillName} from ${teacher.config.name}`);
      }
      return;
    }

    // --- FOUND INSTITUTION (Phase 5) ---
    // e.g. "found The Iron Guild as guild - For all blacksmiths and craftsmen"
    const foundMatch = lower.match(/^found\s+(.+?)\s+as\s+(\w+)\s*(?:[-:]\s*(.+))?/);
    if (foundMatch) {
      const instName = foundMatch[1].trim();
      const instType = foundMatch[2].trim();
      const description = foundMatch[3]?.trim() ?? '';
      const inst: Institution = {
        id: crypto.randomUUID(),
        name: instName,
        type: instType,
        description,
        founderId: actorId,
        members: [{ agentId: actorId, role: 'founder', joinedAt: Date.now() }],
        treasury: 0,
        rules: [],
        createdAt: Date.now(),
      };
      this.world.addInstitution(inst);
      this.broadcaster.institutionUpdate(inst);
      void cognition.addMemory({
        id: crypto.randomUUID(),
        agentId: actorId,
        type: 'plan',
        content: `I founded "${instName}", a ${instType}. ${description}`,
        importance: 9,
        timestamp: Date.now(),
        relatedAgentIds: [],
      });
      console.log(`[Social] ${actorName} founded institution: ${instName} (${instType})`);
      return;
    }

    // --- INVITE TO INSTITUTION (Phase 5) ---
    // e.g. "invite Yuki to The Iron Guild"
    const inviteInstMatch = lower.match(/^invite\s+(.+?)\s+to\s+(.+)/);
    if (inviteInstMatch) {
      const inviteeName = inviteInstMatch[1].trim();
      const instName = inviteInstMatch[2].trim();
      const invitee = this.findAgentByName(inviteeName);
      const inst = this.findInstitutionByName(instName);
      if (invitee && inst && !inst.dissolved) {
        const alreadyMember = inst.members.some(m => m.agentId === invitee.id);
        if (!alreadyMember) {
          this.world.addInstitutionMember(inst.id, { agentId: invitee.id, role: 'member', joinedAt: Date.now() });
          this.broadcaster.institutionUpdate(inst);
          console.log(`[Social] ${actorName} invited ${invitee.config.name} to ${inst.name}`);
        }
      }
      return;
    }

    // --- JOIN INSTITUTION (Phase 5) ---
    // e.g. "join The Iron Guild"
    const joinInstMatch = lower.match(/^join\s+(?:the\s+)?(.+)/);
    if (joinInstMatch) {
      const instName = joinInstMatch[1].trim();
      const inst = this.findInstitutionByName(instName);
      if (inst && !inst.dissolved) {
        const alreadyMember = inst.members.some(m => m.agentId === actorId);
        if (!alreadyMember) {
          this.world.addInstitutionMember(inst.id, { agentId: actorId, role: 'member', joinedAt: Date.now() });
          this.broadcaster.institutionUpdate(inst);
          console.log(`[Social] ${actorName} joined ${inst.name}`);
        }
      }
      return;
    }

    // --- LEAVE INSTITUTION (Phase 5) ---
    // e.g. "leave The Iron Guild"
    const leaveInstMatch = lower.match(/^leave\s+(?:the\s+)?(.+)/);
    if (leaveInstMatch) {
      const instName = leaveInstMatch[1].trim();
      const inst = this.findInstitutionByName(instName);
      if (inst) {
        this.world.removeInstitutionMember(inst.id, actorId);
        this.broadcaster.institutionUpdate(inst);
        console.log(`[Social] ${actorName} left ${inst.name}`);
      }
      return;
    }

    // --- CONTRIBUTE TO INSTITUTION (Phase 5) ---
    // e.g. "contribute 50 gold to The Iron Guild"
    const contributeMatch = lower.match(/^contribute\s+(\d+)\s*(?:gold|coins?|g)\s+to\s+(.+)/);
    if (contributeMatch) {
      const amount = parseInt(contributeMatch[1]);
      const instName = contributeMatch[2].trim();
      const inst = this.findInstitutionByName(instName);
      const actor = this.world.getAgent(actorId);
      if (inst && !inst.dissolved && actor && actor.currency >= amount) {
        const newBalance = this.world.updateAgentCurrency(actorId, -amount);
        this.world.updateInstitutionTreasury(inst.id, amount);
        this.broadcaster.agentCurrency(actorId, newBalance, -amount, `contributed to ${inst.name}`);
        this.broadcaster.institutionUpdate(inst);
        console.log(`[Social] ${actorName} contributed ${amount}G to ${inst.name}`);
      }
      return;
    }

    // --- DISSOLVE INSTITUTION (Phase 5) ---
    // e.g. "dissolve The Iron Guild"
    const dissolveMatch = lower.match(/^dissolve\s+(?:the\s+)?(.+)/);
    if (dissolveMatch) {
      const instName = dissolveMatch[1].trim();
      const inst = this.findInstitutionByName(instName);
      if (inst && !inst.dissolved && inst.founderId === actorId) {
        // Distribute treasury equally among members
        if (inst.treasury > 0 && inst.members.length > 0) {
          const share = Math.floor(inst.treasury / inst.members.length);
          for (const member of inst.members) {
            if (share > 0) {
              const balance = this.world.updateAgentCurrency(member.agentId, share);
              this.broadcaster.agentCurrency(member.agentId, balance, share, `treasury share from dissolved ${inst.name}`);
            }
          }
        }
        this.world.dissolveInstitution(inst.id);
        this.broadcaster.institutionUpdate(inst);
        console.log(`[Social] ${actorName} dissolved ${inst.name}`);
      }
      return;
    }

    // --- WRITE LETTER (Phase 6) ---
    // e.g. "write letter to Yuki - I miss you dearly"
    // Must come before generic create artifact to avoid "write letter" being caught as artifact type
    const letterMatch = lower.match(/^write\s+letter\s+to\s+(.+?)\s*[-:]\s*(.+)/);
    if (letterMatch) {
      const recipientName = letterMatch[1].trim();
      const content = letterMatch[2].trim();
      const recipient = this.findAgentByName(recipientName);
      const actor = this.world.getAgent(actorId);
      const area = actor ? this.world.getAreaAt(actor.position) : undefined;
      const artifact: Artifact = {
        id: crypto.randomUUID(),
        title: `Letter to ${recipient?.config.name ?? recipientName}`,
        content,
        type: 'letter',
        creatorId: actorId,
        creatorName: actorName,
        location: area?.id,
        visibility: 'addressed',
        addressedTo: recipient ? [recipient.id] : [],
        reactions: [],
        createdAt: Date.now(),
        day: this.world.time.day,
      };
      this.world.addArtifact(artifact);
      this.broadcaster.artifactCreated(artifact);
      console.log(`[Social] ${actorName} wrote a letter to ${recipient?.config.name ?? recipientName}`);
      return;
    }

    // --- PUBLISH NEWSPAPER (Phase 6) ---
    // e.g. "publish newspaper - Village Times: Mayor caught stealing!"
    const publishMatch = lower.match(/^publish\s+newspaper\s*[-:]\s*(.+?):\s*(.+)/);
    if (publishMatch) {
      const title = publishMatch[1].trim();
      const content = publishMatch[2].trim();
      const actor = this.world.getAgent(actorId);
      const area = actor ? this.world.getAreaAt(actor.position) : undefined;
      const artifact: Artifact = {
        id: crypto.randomUUID(),
        title,
        content,
        type: 'newspaper',
        creatorId: actorId,
        creatorName: actorName,
        location: area?.id,
        visibility: 'public',
        reactions: [],
        createdAt: Date.now(),
        day: this.world.time.day,
      };
      this.world.addArtifact(artifact);
      this.broadcaster.artifactCreated(artifact);
      void cognition.addMemory({
        id: crypto.randomUUID(),
        agentId: actorId,
        type: 'plan',
        content: `I published a newspaper: "${title}"`,
        importance: 8,
        timestamp: Date.now(),
        relatedAgentIds: [],
      });
      console.log(`[Social] ${actorName} published newspaper: "${title}"`);
      return;
    }

    // --- CREATE ARTIFACT (Phase 6) ---
    // e.g. "create poem - Ode to the Village: The hills are alive..."
    const createArtifactMatch = lower.match(/^(?:create|write|compose|paint)\s+(poem|newspaper|letter|propaganda|diary|painting|law|manifesto|map|recipe)\s*[-:]\s*(.+?):\s*(.+)/);
    if (createArtifactMatch) {
      const artType = createArtifactMatch[1].trim() as Artifact['type'];
      const title = createArtifactMatch[2].trim();
      const content = createArtifactMatch[3].trim();
      const actor = this.world.getAgent(actorId);
      const area = actor ? this.world.getAreaAt(actor.position) : undefined;
      const artifact: Artifact = {
        id: crypto.randomUUID(),
        title,
        content,
        type: artType,
        creatorId: actorId,
        creatorName: actorName,
        location: area?.id,
        visibility: artType === 'diary' ? 'private' : 'public',
        reactions: [],
        createdAt: Date.now(),
        day: this.world.time.day,
      };
      this.world.addArtifact(artifact);
      this.broadcaster.artifactCreated(artifact);
      void cognition.addMemory({
        id: crypto.randomUUID(),
        agentId: actorId,
        type: 'plan',
        content: `I created a ${artType}: "${title}"`,
        importance: 7,
        timestamp: Date.now(),
        relatedAgentIds: [],
      });
      console.log(`[Social] ${actorName} created ${artType}: "${title}"`);
      return;
    }

    // --- BUILD (Phase 7) ---
    // e.g. "build house - Cozy Cottage at forest"
    const buildMatch = lower.match(/^build\s+(\w+)\s*[-:]\s*(.+?)(?:\s+at\s+(.+))?$/);
    if (buildMatch) {
      const buildType = buildMatch[1].trim();
      const buildName = buildMatch[2].trim();
      const locationName = buildMatch[3]?.trim();
      const actor = this.world.getAgent(actorId);
      if (actor) {
        // Check if actor has at least one material item
        const materialItem = actor.inventory.find(i => i.type === 'material');
        if (materialItem) {
          // Consume the material
          this.world.removeItem(materialItem.id);

          // Determine area — use actor's current position, or the specified location name as areaId
          const area = this.world.getAreaAt(actor.position);
          const areaId = locationName ?? area?.id ?? '';

          // Determine effects based on type
          const effectsMap: Record<string, string[]> = {
            house: ['shelter'],
            shop: ['trading'],
            workshop: ['crafting_bonus'],
            shrine: ['healing'],
            tavern: ['shelter', 'trading'],
            barn: ['storage'],
            wall: ['defense'],
          };
          const effects = effectsMap[buildType] ?? [];

          const building: Building = {
            id: crypto.randomUUID(),
            name: buildName,
            type: buildType,
            description: `${buildName}, a ${buildType} built by ${actorName}`,
            ownerId: actorId,
            areaId,
            durability: 100,
            maxDurability: 100,
            effects,
            builtBy: actorId,
            builtAt: Date.now(),
            materials: [materialItem.name],
          };
          this.world.addBuilding(building);
          this.broadcaster.buildingUpdate(building);
          this.broadcaster.agentInventory(actorId, actor.inventory);
          this.broadcaster.agentAction(actorId, `built ${buildName}`, '🏗️');
          void cognition.addMemory({
            id: crypto.randomUUID(),
            agentId: actorId,
            type: 'plan',
            content: `I built a ${buildType} called "${buildName}" at ${areaId}`,
            importance: 8,
            timestamp: Date.now(),
            relatedAgentIds: [],
          });
          console.log(`[Social] ${actorName} built ${buildType}: "${buildName}" at ${areaId}`);
        } else {
          console.log(`[Social] ${actorName} tried to build ${buildName} but has no materials`);
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

    // If it sounds like a public statement, post to board
    const speechPatterns = /^(announce|shout|proclaim|declare|call out|yell)/i;
    if (speechPatterns.test(rawAction)) {
      const actorName = this.world.getAgent(actorId)?.config.name ?? 'Unknown';
      this.world.addBoardPost({
        id: crypto.randomUUID(),
        authorId: actorId,
        authorName: actorName,
        type: 'announcement' as BoardPostType,
        content: rawAction.replace(speechPatterns, '').replace(/^[\s\-:]+/, '').trim(),
        timestamp: Date.now(),
        day: this.world.time.day,
      });
      this.broadcaster.boardPost(this.world.board[this.world.board.length - 1]);
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
