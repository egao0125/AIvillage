/**
 * LeaderElection unit tests
 *
 * Tests are isolated from Redis — the module exports LeaderElection which reads
 * getRedis() at call-time. We use vi.mock() to control the Redis client stub,
 * letting us exercise all branches (Redis available, Redis unavailable, conflict).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Redis stub
// ---------------------------------------------------------------------------
let redisSpy: {
  set: ReturnType<typeof vi.fn>;
  eval: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
} | null = null;

vi.mock('../redis.js', () => ({
  getRedis: () => redisSpy,
}));

// Import AFTER mock is registered
const { LeaderElection } = await import('./leader-election.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeRedis(overrides: Partial<typeof redisSpy> = {}) {
  return {
    set: vi.fn().mockResolvedValue('OK'),
    eval: vi.fn().mockResolvedValue(1),
    get: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('LeaderElection — no Redis (single-Pod fallback)', () => {
  beforeEach(() => { redisSpy = null; });

  it('tryAcquire always returns true', async () => {
    const le = new LeaderElection();
    expect(await le.tryAcquire()).toBe(true);
    expect(le.isLeader).toBe(true);
  });

  it('release sets isLeader=false without throwing', async () => {
    const le = new LeaderElection();
    await le.tryAcquire();
    await le.release();
    expect(le.isLeader).toBe(false);
  });

  it('getCurrentLeaderId returns this podId', async () => {
    const le = new LeaderElection();
    expect(await le.getCurrentLeaderId()).toBe(le.podId);
  });
});

describe('LeaderElection — Redis available', () => {
  let redis: ReturnType<typeof makeRedis>;

  beforeEach(() => {
    redis = makeRedis();
    redisSpy = redis;
  });

  afterEach(() => {
    redisSpy = null;
  });

  it('tryAcquire calls SET NX EX and returns true on OK', async () => {
    const le = new LeaderElection();
    const result = await le.tryAcquire();
    expect(result).toBe(true);
    expect(le.isLeader).toBe(true);
    // Verify correct Redis call
    expect(redis.set).toHaveBeenCalledWith(
      'ai-village:simulation:leader',
      le.podId,
      'EX',
      30,
      'NX',
    );
  });

  it('tryAcquire returns false when key already held (null from SET NX)', async () => {
    redis.set.mockResolvedValue(null); // Redis returns null when NX condition fails
    const le = new LeaderElection();
    const result = await le.tryAcquire();
    expect(result).toBe(false);
    expect(le.isLeader).toBe(false);
  });

  it('tryAcquire returns false on Redis error', async () => {
    redis.set.mockRejectedValue(new Error('ECONNREFUSED'));
    const le = new LeaderElection();
    const result = await le.tryAcquire();
    expect(result).toBe(false);
    expect(le.isLeader).toBe(false);
  });

  it('release calls Lua RELEASE_SCRIPT and sets isLeader=false', async () => {
    const le = new LeaderElection();
    await le.tryAcquire();
    await le.release();
    expect(le.isLeader).toBe(false);
    // release() calls redis.eval with the RELEASE_SCRIPT
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining('del'),
      1,
      'ai-village:simulation:leader',
      le.podId,
    );
    le.destroy();
  });

  it('destroy clears timers without throwing', () => {
    const le = new LeaderElection();
    // Safe to call destroy before any timers are started
    expect(() => le.destroy()).not.toThrow();
  });

  it('startRetrying calls onAcquired when acquire succeeds', async () => {
    vi.useFakeTimers();
    try {
      // First call: another pod holds key (null)
      redis.set.mockResolvedValueOnce(null);
      // Second call (after retry interval): this pod wins
      redis.set.mockResolvedValueOnce('OK');

      const le = new LeaderElection();
      const first = await le.tryAcquire(); // → false
      expect(first).toBe(false);

      let acquired = false;
      le.startRetrying(() => { acquired = true; });

      // Advance past RETRY_INTERVAL_MS (5 s) to trigger the poll
      await vi.advanceTimersByTimeAsync(5_100);

      expect(acquired).toBe(true);
      expect(le.isLeader).toBe(true);
      le.stopRetrying();
      le.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stopRetrying stops polling', () => {
    const le = new LeaderElection();
    let callCount = 0;
    redis.set.mockImplementation(async () => {
      callCount++;
      return null; // never acquire
    });
    le.startRetrying(() => {});
    le.stopRetrying();
    const countAfterStop = callCount;
    // No more calls should happen after stopRetrying
    expect(countAfterStop).toBeLessThanOrEqual(1);
    le.destroy();
  });

  it('getCurrentLeaderId returns the stored pod id', async () => {
    redis.get.mockResolvedValue('other-pod-uuid');
    const le = new LeaderElection();
    expect(await le.getCurrentLeaderId()).toBe('other-pod-uuid');
  });
});

describe('LeaderElection — leadership loss via heartbeat', () => {
  let redis: ReturnType<typeof makeRedis>;

  beforeEach(() => {
    redis = makeRedis();
    redisSpy = redis;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    redisSpy = null;
  });

  it('onLeadershipLost is called when heartbeat eval returns 0', async () => {
    const le = new LeaderElection();
    await le.tryAcquire();
    expect(le.isLeader).toBe(true);

    const lostCallback = vi.fn();
    le.onLeadershipLost = lostCallback;

    // Simulate heartbeat returning 0 (TTL expired / another pod took over)
    redis.eval.mockResolvedValue(0);

    // Advance time past heartbeat interval (10 s)
    await vi.advanceTimersByTimeAsync(10_100);

    expect(lostCallback).toHaveBeenCalledOnce();
    expect(le.isLeader).toBe(false);
    le.destroy();
  });

  it('onLeadershipLost is called when heartbeat throws a Redis error', async () => {
    const le = new LeaderElection();
    await le.tryAcquire();

    const lostCallback = vi.fn();
    le.onLeadershipLost = lostCallback;

    redis.eval.mockRejectedValue(new Error('Redis connection lost'));
    await vi.advanceTimersByTimeAsync(10_100);

    expect(lostCallback).toHaveBeenCalledOnce();
    expect(le.isLeader).toBe(false);
    le.destroy();
  });
});
