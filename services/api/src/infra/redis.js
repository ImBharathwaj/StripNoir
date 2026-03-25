const { createClient } = require('redis');

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

const redisClient = createClient({ url: redisUrl });
redisClient.on('error', (error) => {
  // eslint-disable-next-line no-console
  console.error('Redis error:', error.message);
});

async function ensureRedisConnected() {
  if (!redisClient.isOpen) {
    await redisClient.connect();
  }
}

async function checkRedis() {
  try {
    await ensureRedisConnected();
    const pong = await redisClient.ping();
    return { ok: pong === 'PONG' };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function closeRedis() {
  if (redisClient.isOpen) {
    await redisClient.quit();
  }
}

module.exports = {
  checkRedis,
  closeRedis,
  ensureRedisConnected,
  redisClient
};
