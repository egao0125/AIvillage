import { Redis } from 'ioredis';

// Shared ioredis options for the Redis client.
// maxRetriesPerRequest: null — never throw on pending commands; keep retrying
// until the connection recovers. This prevents the process from crashing when
// Redis is temporarily unreachable.
const REDIS_OPTIONS = {
  retryStrategy: (times: number) => Math.min(times * 200, 5_000),
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  lazyConnect: false,
} as const;

let _redis: Redis | null = null;

/**
 * Initialize a Redis connection from REDIS_URL.
 * Returns null if REDIS_URL is not set — callers should fall back to in-memory.
 *
 * Call once at server startup (index.ts). Subsequent calls to getRedis() return
 * the same client without re-connecting.
 *
 * Used for:
 *  - Socket.IO Redis Streams adapter (single connection, buffered delivery)
 *  - Rate limiting (INCR + TTL)
 */
export function setupRedis(): Redis | null {
  const url = process.env.REDIS_URL;
  if (!url) {
    console.log(
      '[Redis] REDIS_URL not set — Socket.IO and rate limiting use in-memory fallbacks (single-instance only)',
    );
    return null;
  }

  // Amazon Root CA は Node.js 組み込み CA ストアに含まれるため証明書検証を有効化
  // ElastiCache in-transit encryption の証明書は Amazon Trust Services が発行 (Mozilla trust store 収録済み)
  const tlsOptions = url.startsWith('rediss://') ? { tls: { rejectUnauthorized: true } } : {};
  _redis = new Redis(url, { ...REDIS_OPTIONS, ...tlsOptions });

  _redis.on('error', (err: Error) => console.error('[Redis] Error:', err.message || String(err)));
  _redis.on('ready', () => console.log('[Redis] Connected and ready'));

  return _redis;
}

/**
 * Returns the Redis client.
 * Null when Redis is not configured (REDIS_URL unset).
 * Safe to call before setupRedis() — returns null.
 */
export function getRedis(): Redis | null {
  return _redis;
}

/**
 * Close the Redis connection immediately.
 * Uses disconnect() (force-close) rather than quit() so shutdown is instant
 * even when Redis is unreachable and pending reconnects are queued.
 */
export async function closeRedis(): Promise<void> {
  _redis?.disconnect();
  _redis = null;
}
