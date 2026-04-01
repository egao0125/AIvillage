import { useMemo } from 'react';
import { useAgents, useReputation } from '../../core/hooks';
import type { Agent, ReputationEntry, SocialLedgerEntry } from '@ai-village/shared';
import type { SocialNode, SocialEdge, MatchedEntry, SocialFilter } from './types';
import { DEFAULT_FILTER } from './types';

function edgeColor(avgTrust: number): string {
  if (avgTrust > 50) return 'hsl(140, 75%, 50%)';    // bright green — strong trust
  if (avgTrust > 20) return 'hsl(140, 50%, 40%)';    // green — positive
  if (avgTrust > 0)  return 'hsl(140, 30%, 35%)';    // muted green — mild positive
  if (avgTrust > -20) return 'hsl(220, 15%, 30%)';   // dim gray — neutral
  if (avgTrust > -50) return 'hsl(0, 50%, 40%)';     // muted red — tension
  return 'hsl(0, 70%, 45%)';                          // bright red — hostility
}

function matchLedgerEntries(
  aEntries: SocialLedgerEntry[],
  bEntries: SocialLedgerEntry[],
  aId: string,
  bId: string,
): MatchedEntry[] {
  const matched: MatchedEntry[] = [];
  const bByConvo = new Map<string, SocialLedgerEntry>();

  for (const e of bEntries) {
    if (e.sourceConversationId) {
      bByConvo.set(e.sourceConversationId, e);
    }
  }

  const seen = new Set<string>();

  // Match A's entries against B's by sourceConversationId
  for (const aEntry of aEntries) {
    // Only entries involving both agents
    if (!(aEntry.targetIds || []).includes(bId) && aEntry.proposerId !== bId) continue;

    const convoId = aEntry.sourceConversationId;
    if (convoId && bByConvo.has(convoId)) {
      const bEntry = bByConvo.get(convoId)!;
      seen.add(convoId);
      matched.push({
        sourceConversationId: convoId,
        sourceEntry: aEntry,
        targetEntry: bEntry,
        disagreement: aEntry.status !== bEntry.status,
      });
    } else {
      matched.push({
        sourceConversationId: convoId || aEntry.id,
        sourceEntry: aEntry,
        targetEntry: null,
        disagreement: false,
      });
    }
  }

  // B-only entries not matched
  for (const bEntry of bEntries) {
    if (!(bEntry.targetIds || []).includes(aId) && bEntry.proposerId !== aId) continue;
    const convoId = bEntry.sourceConversationId;
    if (convoId && seen.has(convoId)) continue;
    matched.push({
      sourceConversationId: convoId || bEntry.id,
      sourceEntry: bEntry,
      targetEntry: null,
      disagreement: false,
    });
  }

  return matched;
}

export function useSocialGraph(filter: SocialFilter = DEFAULT_FILTER) {
  const agents = useAgents();
  const reputation = useReputation();

  return useMemo(() => {
    const aliveAgents = agents.filter(a => a.alive !== false);

    // Build nodes
    const nodes: SocialNode[] = aliveAgents.map(a => ({
      id: a.id,
      name: a.config.name,
      mood: a.mood || 'neutral',
      state: a.state,
      alive: a.alive !== false,
      x: 0,
      y: 0,
      mapX: a.position.x,
      mapY: a.position.y,
      mentalModels: a.mentalModels || [],
      ledgerEntries: a.socialLedger || [],
      institutionIds: a.institutionIds || [],
    }));

    // Build reputation lookup: key = "fromId:toId"
    const repMap = new Map<string, number>();
    for (const r of reputation) {
      repMap.set(`${r.fromAgentId}:${r.toAgentId}`, r.score);
    }

    // Build edges for each unique pair
    const edges: SocialEdge[] = [];
    const nodeIds = nodes.map(n => n.id);

    for (let i = 0; i < nodeIds.length; i++) {
      for (let j = i + 1; j < nodeIds.length; j++) {
        const aId = nodeIds[i];
        const bId = nodeIds[j];
        const aAgent = aliveAgents.find(a => a.id === aId)!;
        const bAgent = aliveAgents.find(a => a.id === bId)!;

        const aEntries = aAgent.socialLedger || [];
        const bEntries = bAgent.socialLedger || [];

        const sharedEntries = matchLedgerEntries(aEntries, bEntries, aId, bId);

        // Use mental model trust — targetId may be UUID or agent name depending on data source
        const bName = bAgent.config.name;
        const aName = aAgent.config.name;
        const aModel = aAgent.mentalModels?.find(m => m.targetId === bId || m.targetId === bName);
        const bModel = bAgent.mentalModels?.find(m => m.targetId === aId || m.targetId === aName);
        const trustAB = aModel?.trust ?? 0;
        const trustBA = bModel?.trust ?? 0;
        const avgTrust = (trustAB + trustBA) / 2;

        // Need either ledger entries or mental models to show an edge
        if (sharedEntries.length === 0 && !aModel && !bModel) continue;

        const types = new Set(sharedEntries.map(e => e.sourceEntry.type));
        const hasDisagreement = sharedEntries.some(e => e.disagreement);

        // Apply filters
        if (filter.disagreementsOnly && !hasDisagreement) continue;
        if (filter.activeOnly) {
          const hasActive = sharedEntries.some(e =>
            e.sourceEntry.status === 'proposed' || e.sourceEntry.status === 'accepted'
          );
          if (!hasActive && sharedEntries.length > 0) continue;
        }
        if (filter.types.size < 6) {
          const hasMatchingType = [...types].some(t => filter.types.has(t));
          if (!hasMatchingType && sharedEntries.length > 0) continue;
        }

        const interactionCount = sharedEntries.length;
        const thickness = Math.max(1, Math.log2(interactionCount + 1) * 2);

        edges.push({
          id: `${aId}-${bId}`,
          source: aId,
          target: bId,
          interactionCount,
          avgReputation: avgTrust,
          thickness,
          color: edgeColor(avgTrust),
          types,
          hasDisagreement,
          sharedEntries,
        });
      }
    }

    // Apply search filter to nodes
    let filteredNodes = nodes;
    if (filter.searchQuery) {
      const q = filter.searchQuery.toLowerCase();
      const matchingIds = new Set(
        nodes.filter(n => n.name.toLowerCase().includes(q)).map(n => n.id)
      );
      filteredNodes = nodes.map(n => ({
        ...n,
        // Mark non-matching nodes so they can be dimmed
        _dimmed: !matchingIds.has(n.id),
      }));
    }

    return { nodes: filteredNodes, edges };
  }, [agents, reputation, filter]);
}
