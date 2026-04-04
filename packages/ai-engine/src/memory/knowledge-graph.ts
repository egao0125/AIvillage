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
  timestamp: number;  // when this edge was created/updated
  day: number;        // game day
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
   * Add or update an edge. If an edge of the same type between the same
   * entities already exists, update its weight and content.
   */
  addEdge(edge: GraphEdge): void {
    const existing = this.edges.find(e =>
      e.from === edge.from && e.to === edge.to && e.type === edge.type
    );
    if (existing) {
      existing.weight = edge.weight;
      existing.content = edge.content ?? existing.content;
      existing.timestamp = edge.timestamp;
      existing.day = edge.day;
      return;
    }
    this.edges.push(edge);
    // Cap edges — remove oldest low-weight edges
    if (this.edges.length > KnowledgeGraph.MAX_EDGES) {
      this.edges.sort((a, b) => {
        const ws = b.weight - a.weight;
        return ws !== 0 ? ws : b.timestamp - a.timestamp;
      });
      this.edges = this.edges.slice(0, KnowledgeGraph.MAX_EDGES);
    }
  }

  removeEdge(from: string, to: string, type: EdgeType): void {
    this.edges = this.edges.filter(e =>
      !(e.from === from && e.to === to && e.type === type)
    );
  }

  // --- Query methods ---

  /** Get all edges from a specific entity */
  getEdgesFrom(entityId: string, type?: EdgeType): GraphEdge[] {
    return this.edges.filter(e =>
      e.from === entityId && (!type || e.type === type)
    );
  }

  /** Get all edges to a specific entity */
  getEdgesTo(entityId: string, type?: EdgeType): GraphEdge[] {
    return this.edges.filter(e =>
      e.to === entityId && (!type || e.type === type)
    );
  }

  /** Get all edges involving an entity (either direction) */
  getEdgesInvolving(entityId: string, type?: EdgeType): GraphEdge[] {
    return this.edges.filter(e =>
      (e.from === entityId || e.to === entityId) && (!type || e.type === type)
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

      // Expand neighbors via specified edge types
      const outEdges = this.edges.filter(e =>
        e.from === id && edgeTypes.includes(e.type)
      );
      for (const e of outEdges) {
        if (!visited.has(e.to) || visited.get(e.to)! > hops + 1) {
          queue.push({ id: e.to, hops: hops + 1, path: [...path, e.to] });
        }
      }
      // Also check reverse direction for symmetric relationships
      const inEdges = this.edges.filter(e =>
        e.to === id && edgeTypes.includes(e.type) &&
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

  /**
   * Build a social network summary for prompt injection.
   * Returns a concise text block describing the agent's relationship graph.
   */
  buildSocialSummary(agentId: string, nameMap: Map<string, string>, maxChars: number = 200): string {
    const resolveName = (id: string) => nameMap.get(id) ?? id.slice(0, 8);

    const allies = this.getEdgesFrom(agentId, 'allied_with')
      .map(e => resolveName(e.to));
    const trusted = this.getEdgesFrom(agentId, 'trusts')
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 3)
      .map(e => `${resolveName(e.to)} (${e.weight})`);
    const distrusted = this.getEdgesFrom(agentId, 'distrusts')
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 2)
      .map(e => resolveName(e.to));
    const betrayals = this.getEdgesFrom(agentId, 'betrayed')
      .map(e => resolveName(e.to));

    const lines: string[] = [];
    let budget = maxChars;

    if (allies.length > 0) {
      const line = `Allies: ${allies.join(', ')}`;
      if (budget - line.length > 0) { lines.push(line); budget -= line.length; }
    }
    if (trusted.length > 0) {
      const line = `Most trusted: ${trusted.join(', ')}`;
      if (budget - line.length > 0) { lines.push(line); budget -= line.length; }
    }
    if (distrusted.length > 0) {
      const line = `Distrust: ${distrusted.join(', ')}`;
      if (budget - line.length > 0) { lines.push(line); budget -= line.length; }
    }
    if (betrayals.length > 0) {
      const line = `Betrayed: ${betrayals.join(', ')}`;
      if (budget - line.length > 0) { lines.push(line); budget -= line.length; }
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
