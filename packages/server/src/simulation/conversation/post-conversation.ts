import type { Conversation, Memory, SocialLedgerEntry, Commitment } from '@ai-village/shared';
import { AgentCognition } from '@ai-village/ai-engine';
import { AREA_DESCRIPTIONS } from '../../map/starting-knowledge.js';
import type { World } from '../world.js';
import type { EventBroadcaster } from '../events.js';
import { findAgentByName, classifyAgreementType, classifyCommitmentWeight, extractItemsPromised, rewriteVagueTime } from './helpers.js';

const MAX_COMMITMENT_WEIGHT = 15;

/**
 * Handles all post-conversation processing: summary generation, commitment extraction,
 * fact extraction, and social ledger entries — all from a single LLM call per participant.
 *
 * Replaces the old verbatim transcript + gossip extraction + separate extractFacts approach.
 */
export class PostConversationProcessor {
  private broadcaster?: EventBroadcaster;

  constructor(private world: World) {}

  setBroadcaster(broadcaster: EventBroadcaster): void {
    this.broadcaster = broadcaster;
  }

  /**
   * After a conversation ends, generate a compressed summary + structured facts
   * for each participant via one LLM call. No verbatim transcripts stored.
   */
  async process(
    conversation: Conversation,
    cognitions: Map<string, AgentCognition>,
  ): Promise<void> {
    const messages = conversation.messages;
    if (messages.length === 0) return;

    // Build a transcript (used as LLM input, NOT stored)
    const transcript = messages.map(m => `${m.agentName}: ${m.content}`).join('\n');

    // Build area key lookup from AREA_DESCRIPTIONS for place discovery
    const areaNameToKey = new Map<string, string>();
    for (const [key, desc] of Object.entries(AREA_DESCRIPTIONS)) {
      areaNameToKey.set(key, key);
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

      if (otherNames.length === 0) continue;

      const othersLabel = otherNames.length === 1
        ? otherNames[0]
        : `${otherNames.slice(0, -1).join(', ')} and ${otherNames[otherNames.length - 1]}`;

      // --- Single combined LLM call: summary + agreements + learned facts + tension ---
      let result: {
        summary: string;
        agreements: string[];
        learned: string[];
        tension: string | null;
      };

      try {
        const response = await cognition.summarizeConversation(transcript, othersLabel);
        const cleaned = response.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
        const parsed = JSON.parse(cleaned);
        result = {
          summary: typeof parsed.summary === 'string' ? parsed.summary.slice(0, 300) : `I talked with ${othersLabel}.`,
          agreements: Array.isArray(parsed.agreements) ? parsed.agreements.filter((a: any) => typeof a === 'string').slice(0, 2) : [],
          learned: Array.isArray(parsed.learned) ? parsed.learned.filter((f: any) => typeof f === 'string').slice(0, 2) : [],
          tension: typeof parsed.tension === 'string' ? parsed.tension : null,
        };
      } catch (err) {
        console.warn('[PostConversation] LLM response parse failed:', (err as Error).message);
        result = { summary: `I talked with ${othersLabel}.`, agreements: [], learned: [], tension: null };
      }

      // --- 1. Summary memory (replaces verbatim transcript) ---
      const conversationMemoryId = crypto.randomUUID();
      const convContent = `I talked with ${othersLabel}. ${result.summary}`;
      const importance = cognition.scoreImportance(convContent, 'conversation');

      try {
        await cognition.addMemory({
          id: conversationMemoryId,
          agentId: participantId,
          type: 'conversation',
          content: convContent,
          importance,
          timestamp: Date.now(),
          relatedAgentIds: otherIds,
        });
        console.log(`[Memory] ${participant.config.name} stored summary of conversation with ${othersLabel}`);
      } catch (err) {
        console.error(`[Memory] Failed to store conversation summary for ${participant.config.name}:`, err);
      }

      // --- 2. Agreements → memories + social ledger entries (max 2) ---
      for (let agreement of result.agreements.slice(0, 2)) {
        // Rewrite vague time references ("at dawn" → "on Day 5, hour 7") before processing
        agreement = rewriteVagueTime(agreement, this.world.time.day, this.world.time.hour);

        // Memory for this participant
        try {
          await cognition.addLinkedMemory({
            id: crypto.randomUUID(),
            agentId: participantId,
            type: 'plan',
            content: `AGREEMENT with ${othersLabel}: ${agreement}`,
            importance: 7,
            timestamp: Date.now(),
            relatedAgentIds: otherIds,
            causedBy: conversationMemoryId,
          });
        } catch (err) {
          console.warn(`[post-conversation] Failed to write agreement memory for ${participantId}:`, (err as Error).message);
        }

        // Memory for other participants
        for (const otherId of otherIds) {
          const otherCognition = cognitions.get(otherId);
          if (!otherCognition) continue;
          try {
            await otherCognition.addLinkedMemory({
              id: crypto.randomUUID(),
              agentId: otherId,
              type: 'plan',
              content: `AGREEMENT with ${participant.config.name}: ${agreement}`,
              importance: 7,
              timestamp: Date.now(),
              relatedAgentIds: [participantId],
              causedBy: conversationMemoryId,
            });
          } catch (err) {
            console.warn(`[post-conversation] Failed to write agreement memory for agent ${otherId}:`, err);
          }
        }

        // Classify and create commitment or social ledger entry
        const entryType = classifyAgreementType(agreement);
        const now = this.world.time.totalMinutes;
        const day = this.world.time.day;

        if (entryType === 'promise' || entryType === 'task' || entryType === 'meeting') {
          // Create weighted Commitment — meetings are lightweight (weight 1)
          const isPublic = conversation.participants.length > 2;
          let weight: 1 | 3 | 5;
          if (entryType === 'meeting') {
            weight = 1; // meetings are casual commitments — expire same day
          } else {
            // Parse weight prefix from LLM if present, else keyword classify
            const prefixMatch = agreement.match(/^\[(CASUAL|PROMISE|OATH)\]\s*/i);
            if (prefixMatch) {
              const tag = prefixMatch[1].toUpperCase();
              weight = tag === 'OATH' ? 5 : tag === 'CASUAL' ? 1 : 3;
            } else {
              weight = classifyCommitmentWeight(agreement, isPublic, isPublic);
            }
          }
          const items = extractItemsPromised(agreement);
          const cleanAgreement = agreement.replace(/^\[(CASUAL|PROMISE|OATH)\]\s*/i, '');
          const expiresDay = day + (weight === 1 ? 0 : weight === 3 ? 1 : 2);

          // Check weight budget before adding
          const currentWeight = (participant.commitments ?? [])
            .filter(c => !c.fulfilled && !c.broken)
            .reduce((s, c) => s + c.weight, 0);

          if (currentWeight + weight <= MAX_COMMITMENT_WEIGHT) {
            for (const targetId of otherIds) {
              const targetName = this.world.getAgent(targetId)?.config.name ?? 'someone';
              const commitment: Commitment = {
                id: crypto.randomUUID(),
                targetId,
                targetName,
                content: cleanAgreement,
                weight,
                createdDay: day,
                createdHour: this.world.time.hour,
                expiresDay,
                itemsPromised: items.length > 0 ? items : undefined,
                fulfilled: false,
                broken: false,
                sourceConversationId: conversation.id,
              };
              if (!participant.commitments) participant.commitments = [];
              participant.commitments.push(commitment);
            }
          }
        } else {
          // Keep social ledger for trades, alliances, rules
          const expiresAt = now + 1440;
          const thisEntry: SocialLedgerEntry = {
            id: crypto.randomUUID(),
            type: entryType,
            status: 'accepted',
            proposerId: participantId,
            targetIds: otherIds,
            description: `Agreement with ${othersLabel}: ${agreement}`,
            agreedBy: conversation.participants,
            rejectedBy: [],
            createdAt: now,
            expiresAt,
            day,
            sourceConversationId: conversation.id,
            source: 'direct',
          };
          if (!participant.socialLedger) participant.socialLedger = [];
          participant.socialLedger.push(thisEntry);
          this.broadcaster?.ledgerUpdate(participantId, thisEntry);

          for (const otherId of otherIds) {
            const otherAgent = this.world.getAgent(otherId);
            if (!otherAgent) continue;
            const otherEntry: SocialLedgerEntry = {
              id: crypto.randomUUID(),
              type: entryType,
              status: 'accepted',
              proposerId: participantId,
              targetIds: [participantId, ...otherIds.filter(id => id !== otherId)],
              description: `Agreement with ${participant.config.name}: ${agreement}`,
              agreedBy: conversation.participants,
              rejectedBy: [],
              createdAt: now,
              expiresAt,
              day,
              sourceConversationId: conversation.id,
              source: 'direct',
            };
            if (!otherAgent.socialLedger) otherAgent.socialLedger = [];
            otherAgent.socialLedger.push(otherEntry);
            this.broadcaster?.ledgerUpdate(otherId, otherEntry);
          }
        }
      }

      // --- 3. Learned facts → individual memories + place discovery (max 2) ---
      for (const fact of result.learned.slice(0, 2)) {
        // Check for place discovery
        const factLower = fact.toLowerCase();
        for (const [name, key] of areaNameToKey) {
          if (factLower.includes(name)) {
            cognition.addDiscovery(key, AREA_DESCRIPTIONS[key]);
            break;
          }
        }

        try {
          await cognition.addLinkedMemory({
            id: crypto.randomUUID(),
            agentId: participantId,
            type: 'observation',
            content: `${othersLabel} told me: ${fact}`,
            importance: 5,
            timestamp: Date.now(),
            relatedAgentIds: otherIds,
            causedBy: conversationMemoryId,
          });
        } catch (err) {
          console.warn(`[post-conversation] Failed to write learned-fact memory for ${participantId}:`, (err as Error).message);
        }
      }

      // --- 4. Tension → thought memory ---
      if (result.tension) {
        try {
          await cognition.addLinkedMemory({
            id: crypto.randomUUID(),
            agentId: participantId,
            type: 'thought',
            content: result.tension,
            importance: 6,
            timestamp: Date.now(),
            relatedAgentIds: otherIds,
            causedBy: conversationMemoryId,
          });
        } catch (err) {
          console.warn(`[post-conversation] Failed to write tension memory for ${participantId}:`, (err as Error).message);
        }
      }

      // --- 5. Four Stream: update dossiers + add concerns ---
      if (cognition.fourStream) {
        // Update dossier for each conversation partner
        for (const otherId of otherIds) {
          const otherName = this.world.getAgent(otherId)?.config.name || 'someone';
          void cognition.fourStream.updateDossier(
            otherId, otherName, result.summary, cognition.cheapLlm
          ).catch((err: unknown) => {
            console.warn('[PostConversation] updateDossier failed:', (err as Error).message);
          });
        }

        // Commitments are now tracked in agent.commitments[], not as concerns.
        // Only add non-commitment concerns (tension, unresolved issues).

        // Add tension as unresolved concern
        if (result.tension) {
          cognition.fourStream.addConcern({
            id: crypto.randomUUID(),
            content: result.tension,
            category: 'unresolved',
            relatedAgentIds: otherIds,
            createdAt: Date.now(),
          });
        }

        // --- 6. Cultural transmission: share beliefs/strategies between participants ---
        // Agents organically spread knowledge through conversation.
        // Trust-filtered: only share with trusted partners, only accept from trusted sources.
        const shareableMemories = cognition.fourStream.getShareableMemories(2);
        if (shareableMemories.length > 0) {
          for (const otherId of otherIds) {
            const otherCognition = cognitions.get(otherId);
            if (!otherCognition?.fourStream) continue;
            for (const mem of shareableMemories) {
              const accepted = otherCognition.fourStream.receiveSharedMemory(
                mem, participantId, participant.config.name,
              );
              if (accepted) {
                console.log(`[Cultural] ${participant.config.name} → ${this.world.getAgent(otherId)?.config.name}: shared "${mem.content.slice(0, 40)}..."`);
              }
            }
          }
        }
      }
    }
  }
}
