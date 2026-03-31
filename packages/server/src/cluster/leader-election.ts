/**
 * LeaderElection — Redis SETNX-based distributed leader election for multi-Pod deployments.
 *
 * Design intent:
 *   In a horizontally scaled deployment (multiple server Pods behind a load balancer),
 *   only one Pod should run globally-exclusive work such as the simulation tick loop or
 *   scheduled maintenance tasks. This module implements a lightweight advisory lock using
 *   Redis SET NX EX so that exactly one Pod holds the "leader" role at any given time.
 *
 *   - The lock is intentionally ephemeral: if the leader Pod crashes without calling
 *     release(), the TTL (30 s) ensures another Pod can acquire leadership within one
 *     full TTL window. Heartbeats (every 10 s) keep the lock alive as long as the
 *     leader is healthy.
 *
 *   - All mutations that must be conditional on ownership (heartbeat renew, release) use
 *     Lua scripts so the check-then-act is atomic — no TOCTOU race between GET and DEL/EXPIRE.
 *
 *   - When Redis is unavailable (REDIS_URL unset or getRedis() returns null), the module
 *     degrades gracefully: the single Pod is always the leader and no timers are started.
 *     This preserves the single-instance development workflow without any code changes at
 *     the call site.
 *
 *   - podId is a random UUID generated once at construction time and written into the lock
 *     value. Every Redis operation validates ownership against this value, preventing a
 *     newly-elected Pod from releasing a lock that belongs to a different Pod.
 */

import crypto from 'crypto';
import { getRedis } from '../redis.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOCK_KEY = 'ai-village:simulation:leader';
const LOCK_TTL_SEC = 30;        // Redis TTL in seconds
const HEARTBEAT_MS = 10_000;    // renew interval (must be < TTL)
const RETRY_INTERVAL_MS = 5_000; // non-leader polling interval

// ---------------------------------------------------------------------------
// Lua scripts (executed atomically by Redis)
// ---------------------------------------------------------------------------

/**
 * Renew TTL only if this Pod still owns the lock.
 * Returns 1 on success, 0 if ownership has been lost.
 */
const HEARTBEAT_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("expire", KEYS[1], ARGV[2])
else
  return 0
end
` as const;

/**
 * Delete the lock only if this Pod still owns it.
 * Returns 1 on success, 0 if the key is gone or owned by another Pod.
 */
const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
` as const;

// ---------------------------------------------------------------------------
// LeaderElection
// ---------------------------------------------------------------------------

export class LeaderElection {
  /** Unique identifier for this Pod instance, embedded in the Redis lock value. */
  readonly podId: string;

  /** Callback invoked when the leader loses its lock (heartbeat failure). */
  onLeadershipLost?: () => void;

  private _isLeader = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.podId = crypto.randomUUID();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Returns true if this Pod currently holds the leader lock. */
  get isLeader(): boolean {
    return this._isLeader;
  }

  /**
   * Attempt to acquire the leader lock.
   *
   * - No Redis: always returns true (single-Pod fallback).
   * - Redis present: uses SET NX EX. Returns true only when the key was created
   *   by this call. Starts the heartbeat interval on success.
   */
  async tryAcquire(): Promise<boolean> {
    const redis = getRedis();

    // Fallback: no Redis configured — this Pod is always the leader.
    if (!redis) {
      this._isLeader = true;
      return true;
    }

    try {
      const result = await redis.set(LOCK_KEY, this.podId, 'EX', LOCK_TTL_SEC, 'NX');
      if (result === 'OK') {
        this._isLeader = true;
        this.startHeartbeat();
        return true;
      }
      this._isLeader = false;
      return false;
    } catch (err) {
      console.error('[LeaderElection] tryAcquire error:', (err as Error).message);
      this._isLeader = false;
      return false;
    }
  }

  /**
   * Release the leader lock (call during graceful shutdown).
   * Uses a Lua script to ensure only the owning Pod can delete the key.
   * No-op when Redis is not configured or this Pod is not the leader.
   */
  async release(): Promise<void> {
    this.stopHeartbeat();

    const redis = getRedis();
    if (!redis) {
      // Single-Pod fallback — nothing to release in Redis.
      this._isLeader = false;
      return;
    }

    try {
      await redis.eval(RELEASE_SCRIPT, 1, LOCK_KEY, this.podId);
    } catch (err) {
      console.error('[LeaderElection] release error:', (err as Error).message);
    } finally {
      this._isLeader = false;
    }
  }

  /**
   * Start polling for leadership at RETRY_INTERVAL_MS.
   * When tryAcquire() succeeds, polling stops and `onAcquired` is called.
   * Calling this while already retrying replaces the previous retry loop.
   */
  startRetrying(onAcquired: () => void): void {
    this.stopRetrying();

    this.retryTimer = setInterval(() => {
      this.tryAcquire().then((acquired) => {
        if (acquired) {
          this.stopRetrying();
          onAcquired();
        }
      }).catch((err: unknown) => {
        console.error('[LeaderElection] startRetrying poll error:', (err as Error).message);
      });
    }, RETRY_INTERVAL_MS);
  }

  /** Stop the retry polling loop. */
  stopRetrying(): void {
    if (this.retryTimer !== null) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
  }

  /** Stop both the heartbeat and retry timers. Does not release the Redis lock. */
  destroy(): void {
    this.stopHeartbeat();
    this.stopRetrying();
  }

  /**
   * Return the podId currently stored in the lock, or null if no leader is elected.
   * Useful for observability (e.g. logging which Pod holds the lock).
   */
  async getCurrentLeaderId(): Promise<string | null> {
    const redis = getRedis();
    if (!redis) return this.podId; // single-Pod: always this pod

    try {
      return await redis.get(LOCK_KEY);
    } catch (err) {
      console.error('[LeaderElection] getCurrentLeaderId error:', (err as Error).message);
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Start the heartbeat interval that renews the lock TTL.
   * If the Lua script returns 0 (ownership lost), the heartbeat stops and
   * `onLeadershipLost` is invoked so the caller can react (e.g. pause the engine).
   */
  private startHeartbeat(): void {
    this.stopHeartbeat(); // guard against double-start

    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat().catch((err: unknown) => {
        // Unexpected error during the heartbeat — treat as leadership loss to be safe.
        console.error('[LeaderElection] heartbeat unexpected error:', (err as Error).message);
        this.handleLeadershipLost();
      });
    }, HEARTBEAT_MS);
  }

  /** Stop the heartbeat interval without releasing the Redis lock. */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Execute one heartbeat: atomically check ownership and renew TTL.
   * Throws on Redis errors so the caller (startHeartbeat) can catch and
   * invoke handleLeadershipLost().
   */
  private async sendHeartbeat(): Promise<void> {
    const redis = getRedis();
    if (!redis) return; // no Redis — nothing to renew

    let result: unknown;
    try {
      result = await redis.eval(HEARTBEAT_SCRIPT, 1, LOCK_KEY, this.podId, String(LOCK_TTL_SEC));
    } catch (err) {
      console.error('[LeaderElection] heartbeat Redis error:', (err as Error).message);
      this.handleLeadershipLost();
      return;
    }

    if (result === 0) {
      // The key no longer matches our podId — another Pod took over or the key expired.
      this.handleLeadershipLost();
    }
  }

  /** Centralise the "leadership lost" state transition. */
  private handleLeadershipLost(): void {
    this.stopHeartbeat();
    this._isLeader = false;
    try {
      this.onLeadershipLost?.();
    } catch (err) {
      console.error('[LeaderElection] onLeadershipLost callback threw:', (err as Error).message);
    }
  }
}
