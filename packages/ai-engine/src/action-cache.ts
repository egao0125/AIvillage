// ============================================================================
// AI Village — Action Classification Cache (Infra 7)
// Caches freeform action → command mappings to avoid redundant LLM calls.
// Only caches actions with explicit targets (e.g. "gather wheat" not "eat something").
// Cache key includes location to prevent context-insensitive collisions.
// ============================================================================

export class ActionCache {
  /** "normalizedAction@location" → classified command */
  private cache = new Map<string, string>();
  private static readonly MAX_SIZE = 200;

  /** Only cache when the action explicitly names its target */
  private static readonly CACHEABLE = /\b(gather|eat|craft|cook|build|fish|chop|dig|harvest|forage)\s+\w+/i;

  /** Normalize an action string for cache lookup — lowercase, collapse whitespace, strip articles */
  private normalize(action: string): string {
    return action
      .toLowerCase()
      .replace(/\b(the|a|an|some|my|their|his|her)\b/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Build a cache key. Returns null if the action is ambiguous
   * (e.g. "eat something", "do something useful") — those should not be cached.
   */
  private buildKey(action: string, location: string): string | null {
    if (!ActionCache.CACHEABLE.test(action)) return null;
    return `${this.normalize(action)}@${location}`;
  }

  get(action: string, location: string): string | undefined {
    const key = this.buildKey(action, location);
    if (!key) return undefined;
    return this.cache.get(key);
  }

  set(action: string, location: string, command: string): void {
    const key = this.buildKey(action, location);
    if (!key) return; // don't cache ambiguous actions
    // Evict oldest entries if at capacity
    if (this.cache.size >= ActionCache.MAX_SIZE) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) this.cache.delete(firstKey);
    }
    this.cache.set(key, command);
  }
}
