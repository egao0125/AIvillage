/**
 * Knowledge Graph — lightweight in-memory graph for agent relationships, facts, and events.
 * Inspired by Zep/Graphiti: models entities and relationships as typed edges.
 *
 * Enables queries that flat dossiers can't answer:
 * - "Who are Bob's allies?" (traverse alliance edges from Bob)
 * - "What do people I trust think about X?" (filter by trust, then check beliefs)
 * - "Who has betrayed someone?" (scan betrayal edges)
 *
 * Sits alongside FourStreamMemory — not a replacement, an enrichment layer.
 */

// --- Edge Types ---

export type EdgeType =
  | 'trusts'       // A trusts B (weight = trust score)
  | 'distrusts'    // A distrusts B (weight = abs trust score)
  | 'allied_with'  // A is in same institution as B
  | 'betrayed'     // A betrayed B (left institution, broke oath)
  | 'traded_with'  // A traded with B (weight = trade count)
  | 'owes'         // A owes something to B
  | 'fears'        // A fears B
  | 'respects'     // A respects B
  | 'knows_about'  // A knows fact about B (content on edge)
  | 'located_at';  // A is at location B (entity can be a place)

export interface GraphEdge {
  from: string;       // entity ID (agent ID, location ID, etc.)
  to: string;         // entity ID
  type: EdgeType;
  weight: number;     // strength/confidence, typically 0-100
  content?: string;   // optional context ("traded 3 wheat for 2 bread")
  timestamp: number;  // when this edge was created/updated (learnedAt)
  day: number;        // game day

  // Bi-temporal modeling (gap-analysis item 3.1)
  // validFrom/validUntil track truth in the *world*, not when agent learned it.
  // An edge with validUntil set is "historical" — it was true then, not now.
  validFrom?: number;  // game day when this edge became true
  validUntil?: number; // game day when it stopped being true (undefined = still valid)

  // Temporal trend surfacing (gap-analysis item 3.2): recent weight snapshots.
  // Capped at 5 entries — just enough to compute rising/falling/volatile.
  // Only appended when addEdge() updates the weight on a LATER day.
  weightHistory?: { day: number; weight: number }[];
}

export interface GraphNode {
  id: string;
  type: 'agent' | 'location' | 'institution' | 'item';
  name: string;
}

// --- Knowledge Graph ---

export class KnowledgeGraph {
  private nodes: Map<string, GraphNode> = new Map();
  private edges: GraphEdge[] = [];
  private static readonly MAX_EDGES = 500; // per graph instance (per agent)

  // --- Node management ---

  addNode(node: GraphNode): void {
    this.nodes.set(node.id, node);
  }

  getNode(id: string): GraphNode | undefined {
    return this.nodes.get(id);
  }

  // --- Edge management ---

  /**
   * Add or update an edge. If an active edge of the same type between the same
   * entities already exists, update its weight and content. Historical edges
   * (validUntil set) are preserved for bi-temporal queries.
   */
  addEdge(edge: GraphEdge): void {
    const existing = this.edges.find(e =>
      e.from === edge.from && e.to === edge.to && e.type === edge.type &&
      e.validUntil === undefined
    );
    if (existing) {
      // Trend tracking: if the day advanced and the weight actually changed,
      // snapshot the previous weight so trend queries can reconstruct trajectory.
      if (edge.day > existing.day && existing.weight !== edge.weight) {
        const hist = existing.weightHistory ?? [];
        hist.push({ day: existing.day, weight: existing.weight });
        if (hist.length > 5) hist.shift();
        existing.weightHistory = hist;
      }
      existing.weight = edge.weight;
      existing.content = edge.content ?? existing.content;
      existing.timestamp = edge.timestamp;
      existing.day = edge.day;
      if (edge.validFrom !== undefined) existing.validFrom = edge.validFrom;
      return;
    }
    // Default validFrom to day if not set — edge is true "as of now"
    if (edge.validFrom === undefined) edge.validFrom = edge.day;
    this.edges.push(edge);
    // Cap edges — remove oldest low-weight edges. Prefer to evict historical edges first.
    if (this.edges.length > KnowledgeGraph.MAX_EDGES) {
      this.edges.sort((a, b) => {
        // Historical (invalidated) edges sort last — evicted first
        const ah = a.validUntil !== undefined ? 1 : 0;
        const bh = b.validUntil !== undefined ? 1 : 0;
        if (ah !== bh) return ah - bh;
        const ws = b.weight - a.weight;
        return ws !== 0 ? ws : b.timestamp - a.timestamp;
      });
      this.edges = this.edges.slice(0, KnowledgeGraph.MAX_EDGES);
    }
  }

  /**
   * Soft-delete: mark matching edges as historical by setting validUntil.
   * Preserves the edge for bi-temporal queries ("did they used to trust X?").
   * Pass `day` to record when the relationship ended.
   */
  removeEdge(from: string, to: string, type: EdgeType, day?: number): void {
    for (const e of this.edges) {
      if (e.from === from && e.to === to && e.type === type && e.validUntil === undefined) {
        e.validUntil = day ?? e.day;
      }
    }
  }

  // --- Query methods ---
  // By default, only ACTIVE edges (no validUntil) are returned. Pass includeHistorical=true
  // for bi-temporal queries like "who did X used to trust?".

  /** Get all edges from a specific entity (active only by default) */
  getEdgesFrom(entityId: string, type?: EdgeType, includeHistorical: boolean = false): GraphEdge[] {
    return this.edges.filter(e =>
      e.from === entityId && (!type || e.type === type) &&
      (includeHistorical || e.validUntil === undefined)
    );
  }

  /** Get all edges to a specific entity (active only by default) */
  getEdgesTo(entityId: string, type?: EdgeType, includeHistorical: boolean = false): GraphEdge[] {
    return this.edges.filter(e =>
      e.to === entityId && (!type || e.type === type) &&
      (includeHistorical || e.validUntil === undefined)
    );
  }

  /** Get all edges involving an entity (either direction, active only by default) */
  getEdgesInvolving(entityId: string, type?: EdgeType, includeHistorical: boolean = false): GraphEdge[] {
    return this.edges.filter(e =>
      (e.from === entityId || e.to === entityId) && (!type || e.type === type) &&
      (includeHistorical || e.validUntil === undefined)
    );
  }

  /**
   * As-of query: get edges that were ACTIVE on a specific day.
   * Enables queries like "who did X trust on day 5?" even after relationships change.
   */
  getEdgesAsOf(entityId: string, day: number, type?: EdgeType): GraphEdge[] {
    return this.edges.filter(e =>
      (e.from === entityId || e.to === entityId) &&
      (!type || e.type === type) &&
      (e.validFrom ?? e.day) <= day &&
      (e.validUntil === undefined || e.validUntil > day)
    );
  }

  /**
   * Multi-hop traversal: find entities reachable within N hops via specific edge types.
   * Example: "Who are my allies' allies?" = traverse('me', ['allied_with'], 2)
   */
  traverse(startId: string, edgeTypes: EdgeType[], maxHops: number): { id: string; hops: number; path: string[] }[] {
    const visited = new Map<string, number>(); // entity → min hops to reach
    const results: { id: string; hops: number; path: string[] }[] = [];
    const queue: { id: string; hops: number; path: string[] }[] = [{ id: startId, hops: 0, path: [startId] }];

    while (queue.length > 0) {
      const { id, hops, path } = queue.shift()!;
      if (hops > maxHops) continue;
      if (visited.has(id) && visited.get(id)! <= hops) continue;
      visited.set(id, hops);

      if (id !== startId) {
        results.push({ id, hops, path });
      }

      // Expand neighbors via specified edge types (active only — skip historical)
      const outEdges = this.edges.filter(e =>
        e.from === id && edgeTypes.includes(e.type) && e.validUntil === undefined
      );
      for (const e of outEdges) {
        if (!visited.has(e.to) || visited.get(e.to)! > hops + 1) {
          queue.push({ id: e.to, hops: hops + 1, path: [...path, e.to] });
        }
      }
      // Also check reverse direction for symmetric relationships
      const inEdges = this.edges.filter(e =>
        e.to === id && edgeTypes.includes(e.type) && e.validUntil === undefined &&
        ['allied_with', 'traded_with'].includes(e.type) // symmetric types only
      );
      for (const e of inEdges) {
        if (!visited.has(e.from) || visited.get(e.from)! > hops + 1) {
          queue.push({ id: e.from, hops: hops + 1, path: [...path, e.from] });
        }
      }
    }

    return results;
  }

  // --- High-level semantic queries (gap-analysis item 3A) ---
  // These wrap the primitive filters into domain-meaningful lookups that the
  // cognition layer can surface directly into prompts.

  /** Entities this agent is allied with (active only by default). */
  alliesOf(agentId: string, includeHistorical: boolean = false): string[] {
    return this.getEdgesFrom(agentId, 'allied_with', includeHistorical).map(e => e.to);
  }

  /**
   * Entities this agent treats as adversaries: distrust ≥ 30, fears, or has betrayed/been betrayed by.
   * Returns unique entity IDs ordered by combined adversarial weight.
   */
  enemiesOf(agentId: string): { id: string; reasons: string[] }[] {
    const map = new Map<string, { reasons: Set<string>; weight: number }>();
    const bump = (id: string, reason: string, w: number) => {
      const e = map.get(id) ?? { reasons: new Set<string>(), weight: 0 };
      e.reasons.add(reason);
      e.weight += w;
      map.set(id, e);
    };
    for (const e of this.getEdgesFrom(agentId, 'distrusts')) {
      if (e.weight >= 30) bump(e.to, 'distrust', e.weight);
    }
    for (const e of this.getEdgesFrom(agentId, 'fears')) bump(e.to, 'fear', e.weight);
    for (const e of this.getEdgesFrom(agentId, 'betrayed')) bump(e.to, 'I betrayed them', e.weight);
    for (const e of this.getEdgesTo(agentId, 'betrayed')) bump(e.from, 'they betrayed me', e.weight);
    return Array.from(map.entries())
      .sort((a, b) => b[1].weight - a[1].weight)
      .map(([id, v]) => ({ id, reasons: Array.from(v.reasons) }));
  }

  /** Entities both agents are allied with (intersection of allied_with edges). */
  commonAllies(agentA: string, agentB: string): string[] {
    const a = new Set(this.alliesOf(agentA));
    return this.alliesOf(agentB).filter(id => a.has(id));
  }

  /**
   * Shortest trust path from one agent to another via the `trusts` edge type.
   * Useful for transitive introductions: "who can vouch for me to X?".
   * Returns the path of entity IDs, or null if no path exists within maxHops.
   */
  shortestTrustPath(fromId: string, toId: string, maxHops: number = 3): string[] | null {
    if (fromId === toId) return [fromId];
    const paths = this.traverse(fromId, ['trusts'], maxHops);
    const hit = paths.find(p => p.id === toId);
    return hit ? hit.path : null;
  }

  /** Who this agent has betrayed (active + historical — betrayals don't decay). */
  betrayalsFrom(agentId: string): string[] {
    return this.getEdgesFrom(agentId, 'betrayed', true).map(e => e.to);
  }

  /** Who has betrayed this agent. */
  betrayalsOf(agentId: string): string[] {
    return this.getEdgesTo(agentId, 'betrayed', true).map(e => e.from);
  }

  /**
   * Temporal trend (gap-analysis item 3.2): classify how an edge's weight has moved.
   * Uses weightHistory snapshots to detect rising/falling/volatile trajectories
   * without needing an LLM call. Returns `null` if there's no history to compare.
   */
  edgeTrend(
    from: string,
    to: string,
    type: EdgeType,
  ): { trend: 'rising' | 'falling' | 'stable' | 'volatile'; delta: number } | null {
    const edge = this.edges.find(
      e => e.from === from && e.to === to && e.type === type && e.validUntil === undefined,
    );
    if (!edge || !edge.weightHistory || edge.weightHistory.length === 0) return null;
    const oldest = edge.weightHistory[0]!.weight;
    const delta = edge.weight - oldest;
    // Count direction flips in history — high flip count means volatile.
    const series = [...edge.weightHistory.map(h => h.weight), edge.weight];
    let flips = 0;
    for (let i = 2; i < series.length; i++) {
      const prev = series[i - 1]! - series[i - 2]!;
      const curr = series[i]! - series[i - 1]!;
      if (prev !== 0 && curr !== 0 && Math.sign(prev) !== Math.sign(curr)) flips++;
    }
    if (flips >= 2) return { trend: 'volatile', delta };
    if (Math.abs(delta) < 5) return { trend: 'stable', delta };
    return { trend: delta > 0 ? 'rising' : 'falling', delta };
  }

  /**
   * Surface notable trust trends for prompt injection: only agents whose trust
   * has meaningfully moved (|delta| >= 15) or gone volatile. Caller decides
   * how many to show. Returns entries sorted by magnitude of change.
   */
  notableTrustTrends(
    agentId: string,
    minDelta: number = 15,
  ): { targetId: string; trend: 'rising' | 'falling' | 'stable' | 'volatile'; delta: number }[] {
    const out: { targetId: string; trend: 'rising' | 'falling' | 'stable' | 'volatile'; delta: number }[] = [];
    for (const e of this.edges) {
      if (e.from !== agentId || e.validUntil !== undefined) continue;
      if (e.type !== 'trusts' && e.type !== 'distrusts') continue;
      const t = this.edgeTrend(e.from, e.to, e.type);
      if (!t) continue;
      if (t.trend === 'volatile' || Math.abs(t.delta) >= minDelta) {
        out.push({ targetId: e.to, trend: t.trend, delta: t.delta });
      }
    }
    return out.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  }

  /**
   * Build a social network summary for prompt injection.
   * Returns a concise text block describing the agent's relationship graph.
   */
  buildSocialSummary(agentId: string, nameMap: Map<string, string>, maxChars: number = 200): string {
    const resolveName = (id: string) => nameMap.get(id) ?? id.slice(0, 8);

    const allies = this.alliesOf(agentId).map(resolveName);
    const trusted = this.getEdgesFrom(agentId, 'trusts')
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 3)
      .map(e => `${resolveName(e.to)} (${e.weight})`);
    const enemies = this.enemiesOf(agentId)
      .slice(0, 3)
      .map(e => `${resolveName(e.id)} (${e.reasons[0]})`);
    const iBetrayed = this.betrayalsFrom(agentId).map(resolveName);
    const betrayedMe = this.betrayalsOf(agentId).map(resolveName);

    const lines: string[] = [];
    let budget = maxChars;
    const push = (line: string) => {
      if (budget - line.length > 0) { lines.push(line); budget -= line.length + 1; }
    };

    if (allies.length > 0) push(`Allies: ${allies.join(', ')}`);
    if (trusted.length > 0) push(`Most trusted: ${trusted.join(', ')}`);
    if (enemies.length > 0) push(`Enemies: ${enemies.join(', ')}`);
    if (iBetrayed.length > 0) push(`I betrayed: ${iBetrayed.join(', ')}`);
    if (betrayedMe.length > 0) push(`Betrayed me: ${betrayedMe.join(', ')}`);

    // Temporal trend surfacing (gap-analysis item 3.2): top 2 trust shifts
    const trends = this.notableTrustTrends(agentId).slice(0, 2);
    if (trends.length > 0) {
      const trendLine = trends
        .map(t => {
          const name = resolveName(t.targetId);
          if (t.trend === 'volatile') return `${name} (volatile)`;
          const sign = t.delta > 0 ? '+' : '';
          return `${name} (${sign}${t.delta.toFixed(0)})`;
        })
        .join(', ');
      push(`Trust shifts: ${trendLine}`);
    }

    return lines.join('\n');
  }

  /** Get edge count for diagnostics */
  get edgeCount(): number { return this.edges.length; }
  get nodeCount(): number { return this.nodes.size; }

  /** Serialize for persistence */
  serialize(): { nodes: GraphNode[]; edges: GraphEdge[] } {
    return {
      nodes: Array.from(this.nodes.values()),
      edges: this.edges,
    };
  }

  /** Restore from serialized data */
  static deserialize(data: { nodes: GraphNode[]; edges: GraphEdge[] }): KnowledgeGraph {
    const graph = new KnowledgeGraph();
    for (const node of data.nodes) graph.nodes.set(node.id, node);
    graph.edges = data.edges;
    return graph;
  }
}
