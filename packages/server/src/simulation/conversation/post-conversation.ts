import type { Conversation, Memory, SocialLedgerEntry } from '@ai-village/shared';
import { AgentCognition } from '@ai-village/ai-engine';
import { AREA_DESCRIPTIONS } from '../../map/starting-knowledge.js';
import type { World } from '../world.js';
import { findAgentByName, classifyAgreementType } from './helpers.js';

/**
 * Handles all post-conversation processing: memory storage, commitment extraction,
 * gossip/hearsay propagation, and structured fact extraction with social ledger entries.
 *
 * Extracted from the old ConversationManager monolith — logic is identical.
 */
export class PostConversationProcessor {
  constructor(private world: World) {}

  /**
   * After a conversation ends, store what was said as memories for each participant.
   * Each agent gets a memory of the conversation from their perspective.
   */
  async process(
    conversation: Conversation,
    cognitions: Map<string, AgentCognition>,
  ): Promise<void> {
    const messages = conversation.messages;
    if (messages.length === 0) return;

    // Build a transcript
    const transcript = messages.map(m => `${m.agentName}: ${m.content}`).join('\n');

    // Freedom 4: Track conversation memory IDs per participant for causal linking
    const conversationMemoryIds = new Map<string, string>();

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
      const importance = cognition.scoreImportance(convContent, 'conversation');

      // Store the full conversation as a memory
      // Freedom 4: Track memory ID so commitments can link causedBy
      const conversationMemoryId = crypto.randomUUID();
      conversationMemoryIds.set(participantId, conversationMemoryId);
      const memory: Memory = {
        id: conversationMemoryId,
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

      const commitmentLines = agentLines.filter(line => commitmentPattern.test(line) && line.length >= 20);

      if (commitmentLines.length > 0) {
        const otherNames = conversation.participants
          .filter(id => id !== participantId)
          .map(id => this.world.getAgent(id)?.config.name)
          .filter(Boolean);

        try {
          await cognition.addLinkedMemory({
            id: crypto.randomUUID(),
            agentId: participantId,
            type: 'plan',
            content: `COMMITMENT I made to ${otherNames.join(', ')}: ${commitmentLines.join(' ')}`,
            importance: 8,
            timestamp: Date.now(),
            relatedAgentIds: conversation.participants.filter(id => id !== participantId),
            causedBy: conversationMemoryIds.get(participantId),  // Freedom 4: link commitment → conversation
          });
          console.log(`[Memory] ${participant.config.name} stored commitment to ${otherNames.join(', ')}`);

          // Bidirectional: store the promise for the OTHER participants too
          for (const otherId of conversation.participants.filter(id => id !== participantId)) {
            const otherCognition = cognitions.get(otherId);
            if (!otherCognition) continue;
            try {
              await otherCognition.addLinkedMemory({
                id: crypto.randomUUID(),
                agentId: otherId,
                type: 'plan',
                content: `PROMISE from ${participant.config.name}: ${commitmentLines.join(' ')}`,
                importance: 7,
                timestamp: Date.now(),
                relatedAgentIds: [participantId],
                causedBy: conversationMemoryIds.get(otherId),  // Freedom 4: link promise → conversation
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
    await this.extractAndStoreFacts(conversation, cognitions, conversationMemoryIds);
  }

  /**
   * Extract structured facts from a conversation transcript and store each as a separate memory.
   * Place facts update knownPlaces immediately. Person facts tag relatedAgentIds for gossip.
   * Agreement facts are stored for both participants.
   */
  private async extractAndStoreFacts(
    conversation: Conversation,
    cognitions: Map<string, AgentCognition>,
    conversationMemoryIds?: Map<string, string>,
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
      facts = facts.slice(0, 4); // Cap at 4 facts per conversation to reduce memory bloat
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

                // Freedom 5: Detect cultural naming — "they call the park 'Mei's Garden'"
                const culturalNameMatch = fact.content.match(
                  /(?:call(?:ed|s)?|named?|known as|they call it|we call it|nicknamed?)\s+["']?([^"'.]{2,30})["']?/i
                );
                if (culturalNameMatch) {
                  const culturalName = culturalNameMatch[1].trim();
                  if (culturalName.toLowerCase() !== name) {
                    this.world.recordCulturalNameMention(key, culturalName, this.world.time.day);
                  }
                }
                break;
              }
            }
            await cognition.addLinkedMemory({
              id: crypto.randomUUID(),
              agentId: participantId,
              type: 'observation',
              content: `${sourceName} told me: ${fact.content}`,
              importance: 6,
              timestamp: Date.now(),
              relatedAgentIds: otherIds,
              causedBy: conversationMemoryIds?.get(participantId),
            });
            break;
          }

          case 'resource': {
            await cognition.addLinkedMemory({
              id: crypto.randomUUID(),
              agentId: participantId,
              type: 'observation',
              content: `${sourceName} told me: ${fact.content}`,
              importance: 6,
              timestamp: Date.now(),
              relatedAgentIds: otherIds,
              causedBy: conversationMemoryIds?.get(participantId),
            });
            break;
          }

          case 'person': {
            const mentionedAgent = fact.about ? findAgentByName(this.world, fact.about) : undefined;
            const relatedIds = [...otherIds];
            if (mentionedAgent && !relatedIds.includes(mentionedAgent.id)) {
              relatedIds.push(mentionedAgent.id);
            }
            await cognition.addLinkedMemory({
              id: crypto.randomUUID(),
              agentId: participantId,
              type: 'observation',
              content: `${sourceName} told me: ${fact.content}`,
              importance: 5,
              timestamp: Date.now(),
              relatedAgentIds: relatedIds,
              sourceAgentId: otherIds[0],
              hearsayDepth: 1,
              causedBy: conversationMemoryIds?.get(participantId),
            });
            break;
          }

          case 'agreement': {
            // Store memory for this participant
            await cognition.addLinkedMemory({
              id: crypto.randomUUID(),
              agentId: participantId,
              type: 'plan',
              content: `AGREEMENT with ${otherNames.join(', ')}: ${fact.content}`,
              importance: 5,
              timestamp: Date.now(),
              relatedAgentIds: otherIds,
              causedBy: conversationMemoryIds?.get(participantId),
            });
            // Store memory for other participants too
            for (const otherId of otherIds) {
              const otherCognition = cognitions.get(otherId);
              if (!otherCognition) continue;
              try {
                await otherCognition.addLinkedMemory({
                  id: crypto.randomUUID(),
                  agentId: otherId,
                  type: 'plan',
                  content: `AGREEMENT with ${participant.config.name}: ${fact.content}`,
                  importance: 5,
                  timestamp: Date.now(),
                  relatedAgentIds: [participantId],
                  causedBy: conversationMemoryIds?.get(otherId),
                });
              } catch {}
            }

            // --- Social Ledger: create per-agent entries ---
            const entryType = classifyAgreementType(fact.content);
            const sharedConversationId = conversation.id;
            const now = this.world.time.totalMinutes;
            const day = this.world.time.day;
            // Default expiry: 8 game hours (480 minutes) for meetings, 24 hours for others
            const expiresAt = entryType === 'meeting' ? now + 480 : now + 1440;

            // Entry for this participant
            const thisEntry: SocialLedgerEntry = {
              id: crypto.randomUUID(),
              type: entryType,
              status: 'accepted',
              proposerId: participantId,
              targetIds: otherIds,
              description: `Agreement with ${otherNames.join(', ')}: ${fact.content}`,
              agreedBy: conversation.participants,
              rejectedBy: [],
              createdAt: now,
              expiresAt,
              day,
              sourceConversationId: sharedConversationId,
              source: 'direct',
            };
            if (!participant.socialLedger) participant.socialLedger = [];
            participant.socialLedger.push(thisEntry);

            // Entry for each other participant (their own perspective)
            for (const otherId of otherIds) {
              const otherAgent = this.world.getAgent(otherId);
              if (!otherAgent) continue;
              const otherEntry: SocialLedgerEntry = {
                id: crypto.randomUUID(),
                type: entryType,
                status: 'accepted',
                proposerId: participantId,
                targetIds: [participantId, ...otherIds.filter(id => id !== otherId)],
                description: `Agreement with ${participant.config.name}: ${fact.content}`,
                agreedBy: conversation.participants,
                rejectedBy: [],
                createdAt: now,
                expiresAt,
                day,
                sourceConversationId: sharedConversationId,
                source: 'direct',
              };
              if (!otherAgent.socialLedger) otherAgent.socialLedger = [];
              otherAgent.socialLedger.push(otherEntry);
            }

            // Secondhand gossip: if fact.about names someone NOT in the conversation,
            // listeners get a secondhand ledger entry about that external agreement
            if (fact.about) {
              const mentionedAgent = findAgentByName(this.world, fact.about);
              if (mentionedAgent && !conversation.participants.includes(mentionedAgent.id)) {
                // Each listener (non-speaker) gets a secondhand entry
                for (const listenerId of otherIds) {
                  const listener = this.world.getAgent(listenerId);
                  if (!listener) continue;
                  const secondhandEntry: SocialLedgerEntry = {
                    id: crypto.randomUUID(),
                    type: entryType,
                    status: 'accepted',
                    proposerId: participantId,
                    targetIds: [mentionedAgent.id],
                    description: `${participant.config.name} told me: ${fact.content} (involving ${mentionedAgent.config.name})`,
                    agreedBy: [participantId, mentionedAgent.id],
                    rejectedBy: [],
                    createdAt: now,
                    expiresAt,
                    day,
                    sourceConversationId: sharedConversationId,
                    source: 'secondhand',
                  };
                  if (!listener.socialLedger) listener.socialLedger = [];
                  listener.socialLedger.push(secondhandEntry);
                }
              }
            }
            break;
          }

          case 'need': {
            await cognition.addLinkedMemory({
              id: crypto.randomUUID(),
              agentId: participantId,
              type: 'observation',
              content: `${sourceName} said they need: ${fact.content}`,
              importance: 4,
              timestamp: Date.now(),
              relatedAgentIds: otherIds,
              causedBy: conversationMemoryIds?.get(participantId),
            });
            break;
          }

          case 'skill': {
            await cognition.addLinkedMemory({
              id: crypto.randomUUID(),
              agentId: participantId,
              type: 'observation',
              content: `${sourceName} told me: ${fact.content}`,
              importance: 5,
              timestamp: Date.now(),
              relatedAgentIds: otherIds,
              causedBy: conversationMemoryIds?.get(participantId),
            });
            break;
          }
        }
      }
    }
  }
}
