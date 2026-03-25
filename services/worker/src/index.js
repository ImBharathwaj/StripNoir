/**
 * Minimal queue consumer scaffold (Phase 5). Uses Redis BLPOP on a list.
 * Node API can LPUSH jobs later; BullMQ migration path: replace this loop with BullMQ Worker.
 */
const { createClient } = require('redis');

const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const queueKey = process.env.WORKER_NOTIFICATION_QUEUE || 'stripnoir:queue:notifications';
const blockSec = Math.min(Math.max(Number(process.env.WORKER_POLL_BLOCK_SEC || 5), 1), 30);

async function main() {
  const client = createClient({ url: redisUrl });
  client.on('error', (err) => console.error('Redis error:', err.message));
  await client.connect();
  // eslint-disable-next-line no-console
  console.log(`worker listening on ${queueKey} (BLPOP ${blockSec}s)`);

  for (;;) {
    const popped = await client.blPop(queueKey, blockSec);
    if (!popped) {
      continue;
    }
    const payload = popped.element;
    try {
      const job = JSON.parse(payload);
      // eslint-disable-next-line no-console
      console.log('job received', job.type || 'unknown', job.id || '');
      // Hook: dispatch email/push, reconciliation, moderation, etc.
    } catch {
      // eslint-disable-next-line no-console
      console.warn('non-json job payload', String(payload).slice(0, 200));
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
