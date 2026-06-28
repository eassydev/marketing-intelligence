import Redis from 'ioredis';
import { env } from '../../config/env.js';

// BullMQ requires maxRetriesPerRequest: null on its blocking connections; this
// shared client is for app-level use. BullMQ builds its own connection (see
// shared/queue) from the same URL.
export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: 3,
  retryStrategy(times) {
    if (times > 10) return null;
    return Math.min(times * 200, 5000);
  },
});

redis.on('error', (err) => {
  console.error('[redis] Connection error:', err.message);
});
