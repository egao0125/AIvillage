import { Redis } from 'ioredis';

// Shared ioredis options for pub/sub clients used by Socket.IO adapter.
// maxRetriesPerRequest: null — never throw on pending commands; keep retrying
// until the connection recovers. This prevents the process from crashing when
// Redis is temporarily unreachable.
const REDIS_OPTIONS = {
  retryStrategy: (times: number) => Math.min(times * 200, 5_000),
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  lazyConnect: false,
} as const;

let _pub: Redis | null = null;
let _sub: Redis | null = null;

/**
 * Initialize two Redis connections (pub + sub) from REDIS_URL.
 * Returns null if REDIS_URL is not set — callers should fall back to in-memory.
 *
 * Call once at server startup (index.ts). Subsequent calls to getRedis() return
 * the same pub client without re-connecting.
 */
export function setupRedis(): { pub: Redis; sub: Redis } | null {
  const url = process.env.REDIS_URL;
  if (!url) {
    console.log(
      '[Redis] REDIS_URL not set — Socket.IO and rate limiting use in-memory fallbacks (single-instance only)',
    );
    return null;
  }

  _pub = new Redis(url, REDIS_OPTIONS);
  _sub = new Redis(url, REDIS_OPTIONS);

  _pub.on('error', (err: Error) => console.error('[Redis pub] Error:', err.message || String(err)));
  _sub.on('error', (err: Error) => console.error('[Redis sub] Error:', err.message || String(err)));
  _pub.on('ready', () => console.log('[Redis] Connected and ready'));

  return { pub: _pub, sub: _sub };
}

/**
 * Returns the pub/general-purpose Redis client.
 * Null when Redis is not configured (REDIS_URL unset).
 * Safe to call before setupRedis() — returns null.
 */
export function getRedis(): Redis | null {
  return _pub;
}

/**
 * Close both Redis connections immediately.
 * Uses disconnect() (force-close) rather than quit() so shutdown is instant
 * even when Redis is unreachable and pending reconnects are queued.
 */
export async function closeRedis(): Promise<void> {
  _pub?.disconnect();
  _sub?.disconnect();
  _pub = null;
  _sub = null;
}
