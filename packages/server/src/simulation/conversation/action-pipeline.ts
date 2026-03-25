import type { BoardPostType, Conversation, Item, Secret, Artifact, Building, Institution, Agent } from '@ai-village/shared';
import { EventBus } from '@ai-village/shared';
import { AgentCognition, parseIntent, executeAction, RESOURCES, BUILDINGS, getGatherOptions, type ActionOutcome, type AgentState as ResolverAgentState, type WorldState as ResolverWorldState } from '@ai-village/ai-engine';
import type { World } from '../world.js';
import type { EventBroadcaster } from '../events.js';
import { findAgentByName, findInstitutionByName, buildInventoryForResolver, buildSkillsForResolver, buildWorldStateForResolver } from './helpers.js';

export class ActionPipeline {
  recentFailures: Map<string, { count: number; lastType: string; lastLocation: string }> = new Map();
  private _getAgentConversation?: (agentId: string) => { conversationId: string | undefined; participants: string[] };

  constructor(
    private world: World,
    private broadcaster: EventBroadcaster,
    private bus?: EventBus,
  ) {}

  /**
   * Set the callback that retrieves conversation info for an agent.
   * Returns { conversationId, participants } so applyOutcome can determine who hears social acts.
   */
  set getAgentConversation(fn: (agentId: string) => { conversationId: string | undefined; participants: string[] }) {
    this._getAgentConversation = fn;
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
  ): Promise<string> {
    console.log(`[Social] ${actorName} action: ${rawAction}`);
    const actor = this.world.getAgent(actorId);
    if (!actor) return '';

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
      inventory: buildInventoryForResolver(actor),
      skills: buildSkillsForResolver(actor),
      nearbyAgents: nearbyFull.map(a => ({ id: a.id, name: a.config.name })),
    };

    // Build world state for resolver
    const worldState = buildWorldStateForResolver(this.world);

    // Deterministic resolution first — fast, no LLM
    let intent = parseIntent(rawAction, agentState);

    // Freedom 1: Creative physical verbs go straight to resolveAction — skip classifyAction
    // These are genuine novel actions, not parseable by regex but not just self-talk either
    const CREATIVE_VERBS = /\b(arrange|decorate|bury|signal|carve|paint|plant|organize|compose|perform|display|mark|set up|prepare|design|assemble|erect|inscribe|weave|sculpt|construct|demolish|repair|renovate|cultivate)\b/i;
    if ((intent.type === 'unknown' || intent.type === 'intent') && CREATIVE_VERBS.test(rawAction)) {
      try {
        const nearbyNames = nearbyFull.map(a => a.config.name);
        const nearbyDetails = nearbyFull.map(a =>
          `${a.config.name}: ${a.currentAction || 'idle'}, mood: ${a.mood || 'neutral'}`
        );
        const inventoryNames = actor.inventory.map(i => i.name);
        const ops = await cognition.resolveAction(rawAction, {
          location: area?.name ?? 'unknown',
          nearbyAgents: nearbyNames,
          nearbyAgentDetails: nearbyDetails,
          inventory: inventoryNames,
          gold: actor.currency,
        });
        console.log(`[Social] ${actorName} creative action: ${JSON.stringify(ops)}`);
        return this.applyResolvedOps(actorId, actorName, ops, cognition);
      } catch (err) {
        console.error(`[Social] ${actorName} creative resolveAction failed:`, (err as Error).message);
        // Fall through to normal classification path
      }
    }

    // If parseIntent couldn't classify, use LLM to normalize the freeform text
    if (intent.type === 'unknown' || intent.type === 'social' || intent.type === 'intent') {
      try {
        const inventoryNames = actor.inventory.map(i => i.name);
        const cleanAction = await cognition.classifyAction(rawAction, area?.name ?? 'unknown', inventoryNames);
        console.log(`[Social] ${actorName} LLM classified "${rawAction.slice(0, 60)}..." → "${cleanAction}"`);
        const reclassified = parseIntent(cleanAction, agentState);
        if (reclassified.type !== 'unknown' && reclassified.type !== 'social' && reclassified.type !== 'intent') {
          intent = reclassified;
        }
      } catch (err) {
        console.error(`[Social] ${actorName} LLM classify failed:`, (err as Error).message);
      }
    }

    // Freedom 1: If still unknown after LLM classification, route to open-ended resolveAction()
    if (intent.type === 'unknown' || intent.type === 'intent') {
      try {
        const nearbyNames = nearbyFull.map(a => a.config.name);
        const nearbyDetails = nearbyFull.map(a =>
          `${a.config.name}: ${a.currentAction || 'idle'}, mood: ${a.mood || 'neutral'}`
        );
        const inventoryNames = actor.inventory.map(i => i.name);
        const ops = await cognition.resolveAction(rawAction, {
          location: area?.name ?? 'unknown',
          nearbyAgents: nearbyNames,
          nearbyAgentDetails: nearbyDetails,
          inventory: inventoryNames,
          gold: actor.currency,
        });
        console.log(`[Social] ${actorName} open-ended action: ${JSON.stringify(ops)}`);
        const result = this.applyResolvedOps(actorId, actorName, ops, cognition);
        return result;
      } catch (err) {
        console.error(`[Social] ${actorName} resolveAction failed:`, (err as Error).message);
        // Fall through to deterministic execution
      }
    }

    const outcome = executeAction(intent, agentState, worldState);

    // Fix 1: Check resource pool depletion before granting gather
    if (outcome.type === 'gather' && outcome.success && outcome.itemsGained) {
      const gatherArea = this.world.getAreaAt(actor.position);
      const gatherAreaId = gatherArea?.id ?? 'unknown';
      const gatherResource = outcome.itemsGained[0]?.resource;
      if (gatherResource) {
        const poolLevel = this.world.getResourcePool(gatherAreaId, gatherResource);
        if (poolLevel <= 0) {
          outcome.success = false;
          const resName = RESOURCES[gatherResource]?.name ?? gatherResource;
          outcome.description = `There's no ${resName} left here — the area has been depleted.`;
          outcome.itemsGained = undefined;
          outcome.reason = 'resource_depleted';
          outcome.remediation = 'Try a different area, or wait for resources to regenerate.';
        }
      }
    }

    console.log(`[Social] ${actorName} → ${outcome.type}: ${outcome.success ? 'SUCCESS' : 'FAILED'} — ${outcome.description}`);

    // Apply outcome to actual world + store memory
    this.applyOutcome(actorId, actorName, outcome, cognition, cognitions, requestConversation);

    // Return formatted outcome for direct feedback to thinkAfterOutcome()
    if (!outcome.success) {
      let desc = `FAILED: ${outcome.description}`;
      if (outcome.remediation) desc += ` NEXT STEP: ${outcome.remediation}`;
      return desc;
    }
    return `SUCCESS: ${outcome.description}`;
  }

  /**
   * Freedom 1: Apply resolved open-ended action ops to the world.
   * Called when parseIntent + classifyAction both fail to match a known action type.
   */
  private applyResolvedOps(
    actorId: string,
    actorName: string,
    ops: { op: string; [key: string]: any }[],
    cognition: AgentCognition,
  ): string {
    const actor = this.world.getAgent(actorId);
    if (!actor || ops.length === 0) return 'FAILED: Could not resolve action.';

    // Apply energy cost for open-ended actions (5 energy flat)
    if (actor.vitals) {
      actor.vitals.energy = Math.max(0, actor.vitals.energy - 5);
    }

    const descriptions: string[] = [];
    for (const op of ops) {
      this.executeOp(actorId, actorName, op, cognition);
      if (op.op === 'observe') {
        descriptions.push(op.observation || op.content || 'Observed surroundings.');
      } else if (op.op === 'create') {
        descriptions.push(`Created ${op.data?.name || op.type || 'something'}.`);
      } else if (op.op === 'modify') {
        descriptions.push(`Modified ${op.name || op.target || 'something'}.`);
      } else if (op.op === 'interact') {
        descriptions.push(`Interacted with ${op.target || 'someone'}.`);
      } else if (op.op === 'transfer') {
        descriptions.push(`Transferred ${op.item || op.what || 'something'} to ${op.to || 'someone'}.`);
      } else if (op.op === 'remove') {
        descriptions.push(`Removed ${op.item || op.name || 'something'}.`);
      }
    }

    const result = descriptions.join(' ');
    console.log(`[Social] ${actorName} open-ended result: ${result}`);
    return `SUCCESS: ${result}`;
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
            targetIds: data.targetName ? [findAgentByName(this.world, data.targetName)?.id].filter(Boolean) as string[] : undefined,
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
            addressedTo: data.addressedTo ? [findAgentByName(this.world, data.addressedTo)?.id].filter(Boolean) as string[] : [],
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
        else if (type === 'world_object') {
          const area = this.world.getAreaAt(actor.position);
          const worldObj: import('@ai-village/shared').WorldObject = {
            id: crypto.randomUUID(),
            name: data.name || 'object',
            description: data.description || `${data.name}, created by ${actorName}`,
            creatorId: actorId,
            creatorName: actorName,
            areaId: area?.id ?? 'unknown',
            position: { ...actor.position },
            createdAt: this.world.time.totalMinutes,
            lastInteractedAt: this.world.time.totalMinutes,
          };
          this.world.addWorldObject(worldObj);
          this.broadcaster.agentAction(actorId, `created ${worldObj.name}`, '✨');
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
          const aboutAgent = data.about ? findAgentByName(this.world, data.about) : undefined;
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
        // Handle world_object modifications
        if (op.target === 'world_object') {
          const objName = (op.name || '').toLowerCase();
          const area = this.world.getAreaAt(actor.position);
          const areaObjs = area ? this.world.getWorldObjectsAt(area.id) : [];
          const obj = areaObjs.find(o => o.name.toLowerCase().includes(objName));
          if (obj) {
            if (op.description) obj.description = op.description;
            obj.lastInteractedAt = this.world.time.totalMinutes;
            this.broadcaster.agentAction(actorId, `modified ${obj.name}`, '🔧');
          }
          break;
        }

        const targetName = op.target || 'self';
        const target = targetName === 'self' ? actor : findAgentByName(this.world, targetName);
        if (!target) break;

        const field = op.field;
        if (field === 'gold' && op.delta) {
          const newBal = this.world.updateAgentCurrency(target.id, op.delta);
          const reason = op.reason || (op.delta > 0 ? 'received gold' : 'spent gold');
          this.broadcaster.agentCurrency(target.id, newBal, op.delta, reason);
        }
        else if (field === 'reputation' && op.delta) {
          if (target.id === actorId) break; // Can't modify your own reputation
          const aboutAgent = op.about ? findAgentByName(this.world, op.about) : target;
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
          const inst = findInstitutionByName(this.world, op.institution);
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
          const inst = findInstitutionByName(this.world, op.institution);
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
          const candidate = findAgentByName(this.world, op.candidate);
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
        const fromAgent = fromName === 'self' ? actor : findAgentByName(this.world, fromName);
        const toAgent = toName === 'self' ? actor : findAgentByName(this.world, toName);
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
          target = findAgentByName(this.world, who);
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
   * Fix 5: Check if an action violates institutional rules and emit events.
   */
  private checkInstitutionalViolations(actor: Agent, outcome: ActionOutcome): void {
    if (!this.bus) return;
    for (const instId of actor.institutionIds ?? []) {
      const inst = this.world.getInstitution(instId);
      if (!inst || inst.dissolved || !inst.rules) continue;

      for (const rule of inst.rules) {
        const ruleLower = rule.toLowerCase();
        let violated = false;

        if (outcome.type === 'steal' && (ruleLower.includes('no steal') || ruleLower.includes('no theft'))) violated = true;
        if (outcome.type === 'fight' && (ruleLower.includes('no fight') || ruleLower.includes('no violen'))) violated = true;
        if (outcome.type === 'destroy' && (ruleLower.includes('no destroy') || ruleLower.includes('no damag'))) violated = true;

        if (violated) {
          this.bus.emit({
            type: 'rule_violated',
            agentId: actor.id,
            agentName: actor.config.name,
            institutionId: instId,
            institutionName: inst.name,
            rule,
            action: outcome.description,
            location: actor.position,
          });
        }
      }
    }
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

      // Update daily gather count + Freedom 5: deplete resource pool
      if (outcome.type === 'gather') {
        const area = this.world.getAreaAt(actor.position);
        const areaId = area?.id ?? 'unknown';
        const resource = outcome.itemsGained[0]?.resource;
        // Freedom 5: Deplete the persistent resource pool
        if (resource) {
          this.world.depleteResource(areaId, resource);
        }
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

    // --- Teach result (skill update via targetAgentId) ---
    if (outcome.teachResult && outcome.targetAgentId) {
      const target = this.world.getAgent(outcome.targetAgentId);
      if (target) {
        this.world.addSkill(target.id, {
          name: outcome.teachResult.skill,
          level: outcome.teachResult.studentNewLevel,
          xp: 0,
          learnedFrom: actorId,
        });
        const updatedSkill = target.skills.find(s => s.name === outcome.teachResult!.skill);
        if (updatedSkill) this.broadcaster.agentSkill(target.id, updatedSkill);
        // Memory is handled by the unified target handler above
      }
    }

    // --- Give (transfer items to target via targetAgentId) ---
    if (outcome.type === 'give' && outcome.success && outcome.targetAgentId && outcome.itemsConsumed) {
      const target = this.world.getAgent(outcome.targetAgentId);
      if (target) {
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
        // Memory is handled by the unified target handler above
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

    // --- Talk (request conversation via targetAgentId) ---
    if (outcome.type === 'talk' && outcome.success && requestConversation) {
      if (outcome.targetAgentId) {
        requestConversation(actorId, outcome.targetAgentId);
      } else {
        // Fallback for legacy: try regex extraction
        const targetName = outcome.description.match(/talk to (\w+)/)?.[1];
        if (targetName) {
          const target = findAgentByName(this.world, targetName);
          if (target) requestConversation(actorId, target.id);
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
      const convInfo = this._getAgentConversation?.(actorId);
      if (convInfo?.conversationId) {
        hearers = convInfo.participants
          .filter(id => id !== actorId)
          .map(id => this.world.getAgent(id))
          .filter((a): a is Agent => !!a && a.alive !== false);
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

      // Broadcast to feed (not status) — conversation outcomes go to chat feed
      this.broadcaster.agentSpeak(actorId, actor.config.name, outcome.description.slice(0, 80), convInfo?.conversationId ?? '');

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

    // --- Unified target handler: apply effects to the second agent ---
    if (outcome.targetAgentId) {
      const target = this.world.getAgent(outcome.targetAgentId);
      if (target) {
        // Health damage (fight)
        if (outcome.targetHealthChange && target.vitals) {
          target.vitals.health = Math.max(0, Math.min(100,
            target.vitals.health + outcome.targetHealthChange));
        }

        // Items removed from target (steal)
        if (outcome.targetItemsRemoved) {
          for (const removed of outcome.targetItemsRemoved) {
            for (let i = 0; i < removed.qty; i++) {
              const item = target.inventory.find(it =>
                it.name.toLowerCase().replace(/\s+/g, '_') === removed.resource);
              if (item) this.world.removeItem(item.id);
            }
          }
          this.broadcaster.agentInventory(outcome.targetAgentId, target.inventory);
        }

        // Target gets a memory of what happened
        const targetCognition = cognitions?.get(outcome.targetAgentId);
        if (targetCognition && outcome.success) {
          const memoryContent: Record<string, string> = {
            'steal': `${actorName} stole from me! I lost ${outcome.targetItemsRemoved?.map(i => `${i.qty} ${i.resource}`).join(', ') ?? 'something'}.`,
            'fight': `${actorName} attacked me! I took ${Math.abs(outcome.targetHealthChange ?? 0)} damage.`,
            'give': `${actorName} gave me ${outcome.itemsConsumed?.map(i => `${i.qty} ${i.resource}`).join(', ') ?? 'something'}.`,
            'teach': `${actorName} taught me ${outcome.teachResult?.skill ?? 'something'}. I'm now level ${outcome.teachResult?.studentNewLevel ?? '?'}.`,
          };

          const content = memoryContent[outcome.type];
          if (content) {
            void targetCognition.addLinkedMemory({
              id: crypto.randomUUID(),
              agentId: outcome.targetAgentId,
              type: 'observation',
              content,
              importance: outcome.type === 'steal' || outcome.type === 'fight' ? 9 : 7,
              timestamp: Date.now(),
              relatedAgentIds: [actorId],
            });
          }
        }

        // Failed steal — victim notices the attempt
        if (outcome.type === 'steal' && !outcome.success && outcome.reason === 'caught' && targetCognition) {
          void targetCognition.addLinkedMemory({
            id: crypto.randomUUID(),
            agentId: outcome.targetAgentId,
            type: 'observation',
            content: `${actorName} tried to steal from me and I caught them!`,
            importance: 9,
            timestamp: Date.now(),
            relatedAgentIds: [actorId],
          });
        }

        // Event emission for witnesses
        if (this.bus && outcome.success) {
          if (outcome.type === 'steal') {
            const stolenItemName = outcome.targetItemsRemoved?.[0]?.resource ?? 'something';
            this.bus.emit({
              type: 'theft_occurred',
              thiefId: actorId,
              victimId: outcome.targetAgentId,
              item: stolenItemName,
              location: actor.position,
            });
          }
          if (outcome.type === 'fight') {
            this.bus.emit({
              type: 'fight_occurred',
              attackerId: actorId,
              defenderId: outcome.targetAgentId,
              outcome: `${actorName} dealt ${Math.abs(outcome.targetHealthChange ?? 0)} damage, took ${Math.abs(outcome.healthChange)} retaliation`,
              location: actor.position,
            });
          }
        }
      }
    }

    // --- Destroy: apply damage to building durability ---
    if (outcome.type === 'destroy' && outcome.success && !outcome.itemsConsumed) {
      // Not destroying own inventory item — targeting a building
      const area = this.world.getAreaAt(actor.position);
      if (area) {
        const targetName = outcome.description.replace(/^Damaged the /, '').replace(/\.$/, '').toLowerCase();
        for (const [id, building] of this.world.buildings) {
          if (building.areaId === area.id && building.name.toLowerCase().includes(targetName)) {
            const damage = 15 + Math.floor(Math.random() * 11); // 15-25
            building.durability = Math.max(0, building.durability - damage);
            if (building.durability <= 0) {
              this.world.buildings.delete(id);
              this.broadcaster.agentAction(actorId, `destroyed ${building.name}`, '💥');
            } else {
              this.broadcaster.buildingUpdate(building);
            }
            // Owner gets a memory
            if (building.ownerId && building.ownerId !== actorId) {
              const ownerCog = cognitions?.get(building.ownerId);
              if (ownerCog) {
                void ownerCog.addLinkedMemory({
                  id: crypto.randomUUID(),
                  agentId: building.ownerId,
                  type: 'observation',
                  content: building.durability <= 0
                    ? `${actorName} destroyed my ${building.name}!`
                    : `${actorName} damaged my ${building.name}! (${building.durability} durability remaining)`,
                  importance: 9,
                  timestamp: Date.now(),
                  relatedAgentIds: [actorId],
                });
              }
            }
            break;
          }
        }
      }
    }

    // --- Repair: increase building durability ---
    if (outcome.type === 'repair' && outcome.success) {
      const area = this.world.getAreaAt(actor.position);
      if (area) {
        const targetName = outcome.description.replace(/^Repaired the /, '').replace(/\.$/, '').toLowerCase();
        for (const building of this.world.buildings.values()) {
          if (building.areaId === area.id && building.name.toLowerCase().includes(targetName)) {
            const repairAmount = 20 + Math.floor(Math.random() * 11); // 20-30
            building.durability = Math.min(
              building.maxDurability ?? 100,
              building.durability + repairAmount
            );
            this.broadcaster.buildingUpdate(building);
            break;
          }
        }
      }
    }

    // --- Fix 5: Check institutional rule violations ---
    if (outcome.success && this.bus) {
      this.checkInstitutionalViolations(actor, outcome);
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
      memoryLines.push(`NEXT STEP: ${outcome.remediation}`);
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
          inventory: buildInventoryForResolver(actor),
          skills: buildSkillsForResolver(actor),
          nearbyAgents: this.world.getNearbyAgents(actor.position, 8)
            .filter(a => a.id !== actorId && a.alive !== false)
            .map(a => ({ id: a.id, name: a.config.name })),
        };
        const deferredIntent = parseIntent(outcome.deferredAction, deferredAgentState);
        if (deferredIntent.type !== 'unknown' && deferredIntent.type !== 'intent') {
          const deferredOutcome = executeAction(deferredIntent, deferredAgentState, buildWorldStateForResolver(this.world));
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
}
