// ============================================================================
// AI Village — Decision Queue (Infra 3)
// Priority queue for cold-path LLM decisions (plan, think, reflect).
// Hot-path calls (reactive thinks, overhearing) bypass this entirely.
// ============================================================================

export interface PendingDecision {
  id: string;
  agentId: string;
  type: 'think' | 'plan' | 'reflect';
  priority: number;  // lower = higher priority
  context: { trigger: string; details: string };
  enqueuedAt: number;
  expiresAt: number;  // drop if not processed by then
}

export class DecisionQueue {
  private queue: PendingDecision[] = [];
  private inFlight = new Set<string>();  // agentIds with active LLM calls
  private maxConcurrent: number;

  constructor(maxConcurrent: number = 10) {
    this.maxConcurrent = maxConcurrent;
  }

  enqueue(decision: PendingDecision): void {
    // Don't double-enqueue for same agent + type
    const existing = this.queue.find(
      d => d.agentId === decision.agentId && d.type === decision.type
    );
    if (existing) {
      // Replace with newer context if higher priority
      if (decision.priority < existing.priority) {
        this.queue = this.queue.filter(d => d !== existing);
      } else {
        return;
      }
    }
    this.queue.push(decision);
    this.queue.sort((a, b) => a.priority - b.priority);
  }

  dequeue(): PendingDecision | null {
    const now = Date.now();
    // Drop expired decisions
    this.queue = this.queue.filter(d => d.expiresAt > now);
    // Find first decision whose agent isn't already in-flight
    const idx = this.queue.findIndex(d => !this.inFlight.has(d.agentId));
    if (idx === -1) return null;
    if (this.inFlight.size >= this.maxConcurrent) return null;
    const decision = this.queue.splice(idx, 1)[0];
    this.inFlight.add(decision.agentId);
    return decision;
  }

  complete(agentId: string): void {
    this.inFlight.delete(agentId);
  }

  /** Remove all pending decisions for an agent (e.g., on death/removal) */
  removeAgent(agentId: string): void {
    this.queue = this.queue.filter(d => d.agentId !== agentId);
    this.inFlight.delete(agentId);
  }

  get pending(): number { return this.queue.length; }
  get active(): number { return this.inFlight.size; }
}
