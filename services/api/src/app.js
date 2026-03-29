const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { checkPostgres, checkPostgresRead, closePostgres } = require('./infra/db');
const { checkRedis, closeRedis, redisClient, ensureRedisConnected } = require('./infra/redis');
const { pool } = require('./infra/db');
const {
  createMetricsMiddleware,
  pollFallbackHintMiddleware,
  metricsEnabled,
  metricsSingleton
} = require('./infra/httpMetrics');
require('dotenv').config();

const app = express();
if (process.env.TRUST_PROXY === '1' || String(process.env.TRUST_PROXY).toLowerCase() === 'true') {
  app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 1));
}
const port = Number(process.env.PORT || 3000);
const accessTokenSecret = process.env.JWT_ACCESS_SECRET || process.env.JWT_SECRET || 'dev_jwt_secret';
const refreshTokenSecret = process.env.JWT_REFRESH_SECRET || `${accessTokenSecret}_refresh`;
const accessTokenTtl = process.env.JWT_ACCESS_TTL || '15m';
const refreshTokenTtl = process.env.JWT_REFRESH_TTL || '30d';
const chatServiceUrl = process.env.CHAT_SERVICE_URL || 'http://localhost:8080';
/** Browser-facing chat/realtime origin (ws/long-poll). Falls back to CHAT_SERVICE_URL. Use behind API gateway. */
const chatPublicUrl = process.env.CHAT_PUBLIC_URL || chatServiceUrl;
const chatHistoryDelegate =
  !['0', 'false'].includes(String(process.env.CHAT_HISTORY_DELEGATE || '1').toLowerCase());
const chatHistoryShadow =
  String(process.env.CHAT_HISTORY_SHADOW || '').toLowerCase() === '1' ||
  String(process.env.CHAT_HISTORY_SHADOW || '').toLowerCase() === 'true';
const liveAggregateDelegate =
  String(process.env.LIVE_AGGREGATE_DELEGATE || '').toLowerCase() === '1' ||
  String(process.env.LIVE_AGGREGATE_DELEGATE || '').toLowerCase() === 'true';
const liveCreatorPresenceTtlSeconds = Math.max(
  15,
  Number.parseInt(process.env.LIVE_CREATOR_PRESENCE_TTL_SECONDS || '30', 10) || 30
);
const chatInternalApiKey = process.env.CHAT_INTERNAL_API_KEY || '';
/** When false (default), POST /creators/subscription is rejected — use POST /payments/subscribe for paid subs. */
const allowFreeSubscription =
  String(process.env.ALLOW_FREE_SUBSCRIPTION || '').toLowerCase() === '1' ||
  String(process.env.ALLOW_FREE_SUBSCRIPTION || '').toLowerCase() === 'true';

// Opt-in enforcement for “subscribers-only for all creator posts”.
// When enabled, `public` / `followers` visibility are treated as subscribers-only for discovery feeds.
const subscribersOnlyCatalog =
  String(process.env.SUBSCRIBERS_ONLY_CATALOG || '').toLowerCase() === '1' ||
  String(process.env.SUBSCRIBERS_ONLY_CATALOG || '').toLowerCase() === 'true';

const livekitUrl = process.env.LIVEKIT_URL || '';
const livekitApiKey = process.env.LIVEKIT_API_KEY || '';
const livekitApiSecret = process.env.LIVEKIT_API_SECRET || '';
const livekitTokenTtlSeconds = Math.max(Number(process.env.LIVEKIT_TOKEN_TTL_SECONDS || 3600), 60);

// MinIO/S3 presigned uploads (S3 SigV4). We avoid extra SDK deps to keep installs simple.
// MINIO_ENDPOINT: where the API process reaches MinIO (e.g. http://minio:9000 in Docker). Used for
// server-side proxying (public-stream); must not be localhost inside a container unless MinIO is there.
// MINIO_PUBLIC_URL: host embedded in presigned URLs sent to browsers / 302 redirects — reachable from users.
const minioEndpoint = process.env.MINIO_ENDPOINT || 'http://localhost:19000';
function resolveMinioPresignBaseUrl() {
  const explicit = process.env.MINIO_PUBLIC_URL || process.env.MINIO_PRESIGN_BASE_URL;
  if (explicit) return explicit;
  try {
    const endpoint = new URL(minioEndpoint);
    if (endpoint.hostname === 'minio') {
      return `http://localhost:${process.env.MINIO_PORT || '19000'}`;
    }
  } catch {
    // ignore invalid endpoint and use fallback
  }
  return minioEndpoint;
}
const minioPresignBaseUrl = resolveMinioPresignBaseUrl();
const minioBucket = process.env.MINIO_BUCKET || 'stripnoir';
const minioRegion = process.env.MINIO_REGION || 'us-east-1';
const minioAccessKey = process.env.MINIO_ROOT_USER || '';
const minioSecretKey = process.env.MINIO_ROOT_PASSWORD || '';
const minioStorageProvider = process.env.MINIO_STORAGE_PROVIDER || 's3';

function rfc3986Encode(value) {
  return encodeURIComponent(String(value))
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}

function hmacSha256(key, data) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

function getSignatureKey(secretKey, dateStamp, regionName, serviceName) {
  const kDate = hmacSha256(`AWS4${secretKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, regionName);
  const kService = hmacSha256(kRegion, serviceName);
  return hmacSha256(kService, 'aws4_request');
}

function getAmsDateParts() {
  const iso = new Date().toISOString(); // e.g. 2026-03-25T06:41:00.000Z
  const amzDate = iso.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z'); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8); // YYYYMMDD
  return { amzDate, dateStamp };
}

function encodeObjectKey(objectKey) {
  // Canonical URI encodes each segment but keeps '/' as path separators.
  return String(objectKey)
    .split('/')
    .map((seg) => rfc3986Encode(seg))
    .join('/');
}

function createMinioPresignedPutUrl({ objectKey, contentType, expiresSeconds }) {
  if (!minioAccessKey || !minioSecretKey) {
    throw new Error('MINIO_ROOT_USER/MINIO_ROOT_PASSWORD not configured');
  }
  const endpointUrl = new URL(minioPresignBaseUrl);
  const protocol = endpointUrl.protocol.replace(/:$/, '');
  const host = endpointUrl.host; // includes :port when present

  const method = 'PUT';
  const service = 's3';
  const region = minioRegion;
  const { amzDate, dateStamp } = getAmsDateParts();

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const canonicalUri = `/${rfc3986Encode(minioBucket)}/${encodeObjectKey(objectKey)}`;

  const query = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${minioAccessKey}/${credentialScope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiresSeconds),
    'X-Amz-SignedHeaders': 'host'
  };

  const canonicalQueryString = Object.keys(query)
    .sort()
    .map((k) => `${rfc3986Encode(k)}=${rfc3986Encode(query[k])}`)
    .join('&');

  const canonicalHeaders = `host:${host}\n`;
  const signedHeaders = 'host';
  const payloadHash = 'UNSIGNED-PAYLOAD';

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest)
  ].join('\n');

  const signingKey = getSignatureKey(minioSecretKey, dateStamp, region, service);
  const signature = hmacSha256(signingKey, stringToSign).toString('hex');

  const finalQueryString = `${canonicalQueryString}&X-Amz-Signature=${rfc3986Encode(signature)}`;
  const objectPath = `/${rfc3986Encode(minioBucket)}/${encodeObjectKey(objectKey)}`;
  return `${protocol}://${host}${objectPath}?${finalQueryString}`;
}

/**
 * @param {{ objectKey: string, expiresSeconds: number, forServerFetch?: boolean }} opts
 * When forServerFetch is true, signs against MINIO_ENDPOINT so the API can open the URL from Docker
 * (presigned URLs built with MINIO_PUBLIC_URL often use localhost, which is wrong inside a container).
 */
function createMinioPresignedGetUrl({ objectKey, expiresSeconds, forServerFetch = false }) {
  if (!minioAccessKey || !minioSecretKey) {
    throw new Error('MINIO_ROOT_USER/MINIO_ROOT_PASSWORD not configured');
  }
  const baseForSigning = forServerFetch ? minioEndpoint : minioPresignBaseUrl;
  const endpointUrl = new URL(baseForSigning);
  const protocol = endpointUrl.protocol.replace(/:$/, '');
  const host = endpointUrl.host;

  const method = 'GET';
  const service = 's3';
  const region = minioRegion;
  const { amzDate, dateStamp } = getAmsDateParts();

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const canonicalUri = `/${rfc3986Encode(minioBucket)}/${encodeObjectKey(objectKey)}`;

  const query = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${minioAccessKey}/${credentialScope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiresSeconds),
    'X-Amz-SignedHeaders': 'host'
  };

  const canonicalQueryString = Object.keys(query)
    .sort()
    .map((k) => `${rfc3986Encode(k)}=${rfc3986Encode(query[k])}`)
    .join('&');

  const canonicalHeaders = `host:${host}\n`;
  const signedHeaders = 'host';
  const payloadHash = 'UNSIGNED-PAYLOAD';

  const canonicalRequest = [method, canonicalUri, canonicalQueryString, canonicalHeaders, signedHeaders, payloadHash].join('\n');

  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, sha256Hex(canonicalRequest)].join('\n');

  const signingKey = getSignatureKey(minioSecretKey, dateStamp, region, service);
  const signature = hmacSha256(signingKey, stringToSign).toString('hex');

  const finalQueryString = `${canonicalQueryString}&X-Amz-Signature=${rfc3986Encode(signature)}`;
  const objectPath = `/${rfc3986Encode(minioBucket)}/${encodeObjectKey(objectKey)}`;
  return `${protocol}://${host}${objectPath}?${finalQueryString}`;
}

app.use(cors());
app.use(express.json());
app.use(morgan('dev'));
app.use(createMetricsMiddleware(metricsSingleton));

if (metricsEnabled()) {
  app.get('/metrics', (req, res) => {
    res.type('text/plain; version=0.0.4; charset=utf-8');
    res.send(metricsSingleton.prometheusText());
  });
  app.get('/metrics.json', (req, res) => {
    res.json(metricsSingleton.jsonSummary());
  });
}

app.get('/health', (req, res) => {
  res.json({ service: 'api', status: 'ok', port });
});

app.get('/health/deps', async (req, res) => {
  const [postgres, postgresRead, redis] = await Promise.all([
    checkPostgres(),
    checkPostgresRead(),
    checkRedis()
  ]);
  const allHealthy = postgres.ok && postgresRead.ok && redis.ok;

  // LiveKit readiness is config/contract-level; we don't gate basic health/deps
  // because LiveKit may be intentionally disabled for certain environments.
  const livekit = {
    configured: isLiveKitConfigured()
  };

  res.status(allHealthy ? 200 : 503).json({
    service: 'api',
    status: allHealthy ? 'ok' : 'degraded',
    dependencies: {
      postgres,
      postgresRead,
      redis,
      livekit
    }
  });
});

const v1 = express.Router();

function createRedisFixedWindowLimiter({ prefix, windowSec, max }) {
  const window = Math.max(1, Number(windowSec) || 60);
  const limit = Math.max(1, Number(max) || 100);
  return async function rateLimitMiddleware(req, res, next) {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const key = `${prefix}:${ip}`;
    try {
      await ensureRedisConnected();
      const n = await redisClient.incr(key);
      if (n === 1) {
        await redisClient.expire(key, window);
      }
      const remaining = Math.max(0, limit - n);
      res.setHeader('RateLimit-Limit', String(limit));
      res.setHeader('RateLimit-Remaining', String(remaining));
      if (n > limit) {
        return res.status(429).json({ error: 'too many requests' });
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('rate limit redis error:', err.message);
    }
    return next();
  };
}

const apiGeneralLimiter = createRedisFixedWindowLimiter({
  prefix: 'rl:v1',
  windowSec: process.env.API_RATE_LIMIT_WINDOW_SEC || 60,
  max: process.env.API_RATE_LIMIT_MAX || 200
});
const apiAuthLimiterFlag = String(process.env.API_AUTH_RATE_LIMIT_ENABLED || 'true').toLowerCase() !== 'false';
const apiAuthLimiter = createRedisFixedWindowLimiter({
  prefix: 'rl:auth',
  windowSec: process.env.API_AUTH_RATE_LIMIT_WINDOW_SEC || 900,
  max: process.env.API_AUTH_RATE_LIMIT_MAX || 40
});
v1.use(apiGeneralLimiter);
v1.use(pollFallbackHintMiddleware);

/** Same as public-read route; keys are uploads|content|subscription-content / userId / objectId (UUIDs with hyphens). */
const PUBLIC_MEDIA_KEY_RE = /^(uploads|content|subscription-content)\/[\da-f-]{36}\/[\da-f-]{36}$/i;

function rewriteStoredMediaUrlToPublicRead(stored) {
  if (stored == null || stored === '') return stored;
  if (typeof stored !== 'string') return stored;
  const t = stored.trim();
  if (!t) return stored;
  if (t.startsWith('/api/v1/media/public-read')) return t;
  try {
    const publicBase = new URL(minioPresignBaseUrl);
    const u = new URL(t);
    const pathOk = /^\/[^/]+\/(uploads|content|subscription-content)\/[\da-f-]{36}\/[\da-f-]{36}\/?$/i.test(
      u.pathname
    );
    if (u.host !== publicBase.host && !pathOk) return stored;
    const segs = u.pathname.replace(/^\/+/, '').split('/').filter(Boolean);
    if (segs.length < 3) return stored;
    const [bkt, ...rest] = segs;
    const key = rest.join('/');
    if (bkt !== minioBucket || !PUBLIC_MEDIA_KEY_RE.test(key)) return stored;
    return `/api/v1/media/public-read?${new URLSearchParams({ bucket: bkt, key }).toString()}`;
  } catch {
    return stored;
  }
}

/** Fan-visible blurb: creator_profile.about, else user_account.bio (many creators only edit /me bio). */
function mergeCreatorPublicAbout(row) {
  const a = row.about != null ? String(row.about).trim() : '';
  const b = row.bio != null ? String(row.bio).trim() : '';
  if (a) return a;
  if (b) return b;
  return null;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function sanitizeUser(row) {
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    displayName: row.display_name,
    avatarUrl: row.avatar_url != null ? rewriteStoredMediaUrlToPublicRead(row.avatar_url) : null,
    bio: row.bio != null ? row.bio : null,
    status: row.status,
    createdAt: row.created_at
  };
}

function sanitizeCreator(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    userId: row.user_id,
    stageName: row.stage_name,
    about: row.about,
    categoryTags: row.category_tags || [],
    isNsfw: row.is_nsfw,
    verificationStatus: row.verification_status,
    defaultSubscriptionPriceCredits: row.default_subscription_price_credits,
    liveEnabled: row.live_enabled,
    chatEnabled: row.chat_enabled,
    videoCallEnabled: row.video_call_enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

let ensureCreatorProfileCompatibilityColumnsPromise = null;

async function ensureCreatorProfileCompatibilityColumns() {
  if (!ensureCreatorProfileCompatibilityColumnsPromise) {
    ensureCreatorProfileCompatibilityColumnsPromise = pool.query(
      `ALTER TABLE creator_profile
         ADD COLUMN IF NOT EXISTS chat_enabled BOOLEAN NOT NULL DEFAULT FALSE,
         ADD COLUMN IF NOT EXISTS video_call_enabled BOOLEAN NOT NULL DEFAULT FALSE,
         ADD COLUMN IF NOT EXISTS live_enabled BOOLEAN NOT NULL DEFAULT FALSE,
         ADD COLUMN IF NOT EXISTS is_nsfw BOOLEAN NOT NULL DEFAULT TRUE`
    ).catch((error) => {
      ensureCreatorProfileCompatibilityColumnsPromise = null;
      throw error;
    });
  }
  await ensureCreatorProfileCompatibilityColumnsPromise;
}

function sanitizeContent(row) {
  return {
    id: row.id,
    creatorId: row.creator_id,
    title: row.title,
    caption: row.caption,
    visibility: row.visibility,
    status: row.status,
    requiresPayment: row.requires_payment,
    unlockPriceCredits: row.unlock_price_credits,
    publishedAt: row.published_at,
    scheduledFor: row.scheduled_for,
    metadata: row.metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function sanitizeSubscriptionExclusiveContent(row) {
  return {
    id: row.id,
    creatorId: row.creator_id,
    title: row.title,
    caption: row.caption,
    status: row.status,
    publishedAt: row.published_at,
    metadata: row.metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function sanitizeNotificationRow(row) {
  return {
    id: row.id,
    userId: row.user_id,
    type: row.type,
    status: row.status,
    title: row.title,
    body: row.body,
    deepLink: row.deep_link,
    payload: row.payload,
    createdAt: row.created_at,
    readAt: row.read_at,
    archivedAt: row.archived_at
  };
}

function sanitizeLiveSession(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    creatorId: row.creator_id,
    creatorUserId: row.creator_user_id,
    roomId: row.room_id,
    livekitRoomName: row.livekit_room_name,
    title: row.title,
    description: row.description,
    streamThumbnailUrl: rewriteStoredMediaUrlToPublicRead(row.stream_thumbnail_url),
    status: row.status,
    scheduledStartAt: row.scheduled_start_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    baseJoinPriceCredits: row.base_join_price_credits,
    extendPriceCredits: row.extend_price_credits,
    extendDurationSeconds: row.extend_duration_seconds,
    maxConcurrentViewers: row.max_concurrent_viewers,
    metadata: row.metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    creator: {
      id: row.creator_id,
      userId: row.creator_user_id,
      stageName: row.stage_name,
      username: row.username,
      displayName: row.display_name,
      avatarUrl: rewriteStoredMediaUrlToPublicRead(row.avatar_url)
    },
    stats: {
      activeViewers: Number(row.active_viewer_count || 0)
    }
  };
}

function sanitizeVideoCallSession(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    requestId: row.request_id,
    clientUserId: row.client_user_id,
    creatorId: row.creator_id,
    creatorUserId: row.creator_user_id,
    roomId: row.room_id,
    livekitRoomName: row.livekit_room_name,
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    expiresAt: row.expires_at,
    creditsPerBlock: row.credits_per_block,
    blockDurationSeconds: row.block_duration_seconds,
    totalBilledCredits: Number(row.total_billed_credits || 0),
    metadata: row.metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    creator: {
      id: row.creator_id,
      userId: row.creator_user_id,
      stageName: row.stage_name,
      username: row.username,
      displayName: row.display_name
    }
  };
}

function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    return xff.split(',')[0].trim();
  }
  return req.socket.remoteAddress || null;
}

function parsePositiveInteger(input) {
  const value = Number(input);
  if (!Number.isInteger(value) || value <= 0) {
    return null;
  }
  return value;
}

async function hasActiveSubscription(subscriberUserId, creatorId) {
  const subscription = await pool.query(
    `SELECT 1
     FROM subscription
     WHERE subscriber_user_id = $1
       AND creator_id = $2
       AND status = 'active'
       AND (current_period_end IS NULL OR current_period_end > now())
     LIMIT 1`,
    [subscriberUserId, creatorId]
  );
  return subscription.rows.length > 0;
}

async function userHasContentAccessGrant(userId, contentPostId) {
  const r = await pool.query(
    `SELECT 1
     FROM content_access_grant
     WHERE content_post_id = $1
       AND granted_to_user_id = $2
       AND (expires_at IS NULL OR expires_at > now())
     LIMIT 1`,
    [contentPostId, userId]
  );
  return r.rows.length > 0;
}

async function hasContentUnlockLedger(userId, contentPostId) {
  const r = await pool.query(
    `SELECT 1
     FROM credit_ledger
     WHERE user_id = $1
       AND direction = 'debit'
       AND entry_type = 'content_unlock_debit'
       AND reference_type = 'content_unlock'
       AND reference_id = $2
     LIMIT 1`,
    [userId, contentPostId]
  );
  return r.rows.length > 0;
}

/** Row must include content_post columns plus creator_user_id (from join). */
async function userCanViewContentPost(userId, row) {
  if (row.creator_user_id === userId) {
    return true;
  }
  if (row.status !== 'published') {
    return false;
  }

  if (row.visibility === 'public') {
    if (subscribersOnlyCatalog) {
      return hasActiveSubscription(userId, row.creator_id);
    }
    return true;
  }

  if (row.visibility === 'followers') {
    if (subscribersOnlyCatalog) {
      return hasActiveSubscription(userId, row.creator_id);
    }
    const follow = await pool.query(
      `SELECT 1
       FROM follow_relation
       WHERE follower_user_id = $1 AND creator_user_id = $2
       LIMIT 1`,
      [userId, row.creator_user_id]
    );
    return follow.rows.length > 0;
  }

  const subscribed = await hasActiveSubscription(userId, row.creator_id);

  if (row.visibility === 'subscribers') {
    return subscribed;
  }

  if (row.visibility === 'private') {
    return subscribed;
  }

  if (row.visibility === 'exclusive_ppv') {
    if (row.requires_payment) {
      if (subscribed) {
        return true;
      }
      if (await userHasContentAccessGrant(userId, row.id)) {
        return true;
      }
      if (await hasContentUnlockLedger(userId, row.id)) {
        return true;
      }
      return false;
    }
    return subscribed;
  }

  return false;
}

async function userHasCreatorProfile(userId) {
  const r = await pool.query(
    `SELECT 1 FROM creator_profile WHERE user_id = $1 LIMIT 1`,
    [userId]
  );
  return r.rows.length > 0;
}

async function getCreatorProfileForUser(userId, db = pool) {
  const result = await db.query(
    `SELECT id, user_id, stage_name
     FROM creator_profile
     WHERE user_id = $1
     LIMIT 1`,
    [userId]
  );
  return result.rows[0] || null;
}

async function ensureWallet(client, userId) {
  await client.query(
    `INSERT INTO wallet_account (user_id)
     VALUES ($1)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId]
  );
}

async function loadWalletForUpdate(client, userId) {
  const wallet = await client.query(
    `SELECT id, user_id, available_credits, held_credits, lifetime_earned_credits, lifetime_spent_credits
     FROM wallet_account
     WHERE user_id = $1
     FOR UPDATE`,
    [userId]
  );
  return wallet.rows[0] || null;
}

async function transferCredits({
  client,
  fromUserId,
  toUserId,
  amountCredits,
  debitEntryType,
  creditEntryType,
  referenceType,
  referenceId
}) {
  await ensureWallet(client, fromUserId);
  await ensureWallet(client, toUserId);

  const fromWallet = await loadWalletForUpdate(client, fromUserId);
  const toWallet = await loadWalletForUpdate(client, toUserId);
  if (!fromWallet || !toWallet) {
    throw new Error('wallet not found');
  }
  if (Number(fromWallet.available_credits) < amountCredits) {
    const insufficient = new Error('insufficient credits');
    insufficient.code = 'INSUFFICIENT_CREDITS';
    throw insufficient;
  }

  const fromBefore = Number(fromWallet.available_credits);
  const fromAfter = fromBefore - amountCredits;
  const toBefore = Number(toWallet.available_credits);
  const toAfter = toBefore + amountCredits;

  await client.query(
    `UPDATE wallet_account
     SET available_credits = $1,
         lifetime_spent_credits = lifetime_spent_credits + $2,
         updated_at = now()
     WHERE id = $3`,
    [fromAfter, amountCredits, fromWallet.id]
  );
  await client.query(
    `UPDATE wallet_account
     SET available_credits = $1,
         lifetime_earned_credits = lifetime_earned_credits + $2,
         updated_at = now()
     WHERE id = $3`,
    [toAfter, amountCredits, toWallet.id]
  );

  const debitLedger = await client.query(
    `INSERT INTO credit_ledger (
       wallet_id, user_id, direction, entry_type, amount_credits,
       balance_before, balance_after, counterpart_user_id, reference_type, reference_id
     )
     VALUES ($1, $2, 'debit', $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, created_at`,
    [
      fromWallet.id,
      fromUserId,
      debitEntryType,
      amountCredits,
      fromBefore,
      fromAfter,
      toUserId,
      referenceType || null,
      referenceId || null
    ]
  );
  const creditLedger = await client.query(
    `INSERT INTO credit_ledger (
       wallet_id, user_id, direction, entry_type, amount_credits,
       balance_before, balance_after, counterpart_user_id, reference_type, reference_id
     )
     VALUES ($1, $2, 'credit', $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, created_at`,
    [
      toWallet.id,
      toUserId,
      creditEntryType,
      amountCredits,
      toBefore,
      toAfter,
      fromUserId,
      referenceType || null,
      referenceId || null
    ]
  );

  await client.query(
    `INSERT INTO credit_transfer (debit_ledger_id, credit_ledger_id, transfer_type, amount_credits, status)
     VALUES ($1, $2, $3, $4, 'completed')`,
    [
      debitLedger.rows[0].id,
      creditLedger.rows[0].id,
      referenceType || 'transfer',
      amountCredits
    ]
  );

  return {
    amountCredits,
    fromUserId,
    toUserId,
    fromWallet: { before: fromBefore, after: fromAfter },
    toWallet: { before: toBefore, after: toAfter },
    ledger: {
      debitLedgerId: debitLedger.rows[0].id,
      creditLedgerId: creditLedger.rows[0].id,
      createdAt: debitLedger.rows[0].created_at
    }
  };
}

async function issueSessionTokens({ userId, email, role, userAgent, ipAddress }) {
  const sessionInsert = await pool.query(
    `INSERT INTO auth_session (user_id, refresh_token_hash, user_agent, ip_address, expires_at, status)
     VALUES ($1, '', $2, $3, now() + ($4)::interval, 'active')
     RETURNING id`,
    [userId, userAgent || null, ipAddress || null, refreshTokenTtl]
  );
  const sessionId = sessionInsert.rows[0].id;

  const accessToken = jwt.sign(
    { sub: userId, email, role, typ: 'access' },
    accessTokenSecret,
    { expiresIn: accessTokenTtl }
  );
  const refreshToken = jwt.sign(
    { sub: userId, sid: sessionId, typ: 'refresh' },
    refreshTokenSecret,
    { expiresIn: refreshTokenTtl }
  );
  const refreshTokenHash = hashToken(refreshToken);

  await pool.query(
    `UPDATE auth_session
     SET refresh_token_hash = $1
     WHERE id = $2`,
    [refreshTokenHash, sessionId]
  );

  return {
    accessToken,
    refreshToken,
    sessionId
  };
}

function authRequired(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing Bearer token' });
  }

  const token = authHeader.slice('Bearer '.length);
  try {
    const payload = jwt.verify(token, accessTokenSecret);
    req.auth = payload;
    return next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid or expired access token' });
  }
}

async function isRoomParticipant(roomId, userId) {
  const membership = await pool.query(
    `SELECT 1
     FROM chat_room_participant
     WHERE room_id = $1
       AND user_id = $2
       AND left_at IS NULL
     LIMIT 1`,
    [roomId, userId]
  );
  return membership.rows.length > 0;
}

async function areUsersBlocked(userA, userB, db = pool) {
  const blocked = await db.query(
    `SELECT 1
     FROM user_block
     WHERE (blocker_user_id = $1 AND blocked_user_id = $2)
        OR (blocker_user_id = $2 AND blocked_user_id = $1)
     LIMIT 1`,
    [userA, userB]
  );
  return blocked.rows.length > 0;
}

async function getOtherDirectRoomParticipant(roomId, userId, db = pool) {
  const result = await db.query(
    `SELECT u.id::text AS other_user_id
     FROM chat_room_participant crp
     INNER JOIN user_account u ON u.id = crp.user_id
     WHERE crp.room_id = $1
       AND crp.user_id <> $2
       AND crp.left_at IS NULL
     LIMIT 1`,
    [roomId, userId]
  );
  return result.rows[0]?.other_user_id || null;
}

async function publishChatEvent(roomId, eventType, payload) {
  const body = {
    roomId,
    eventType,
    payload
  };

  const headers = {
    'content-type': 'application/json'
  };
  if (chatInternalApiKey) {
    headers['x-internal-key'] = chatInternalApiKey;
  }

  const response = await fetch(`${chatServiceUrl}/internal/chat/publish`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`chat publish failed: ${response.status} ${text}`);
  }
}

async function publishNotifyEvent(userId, eventType, payload) {
  const body = {
    userId,
    eventType,
    payload
  };
  const headers = {
    'content-type': 'application/json'
  };
  if (chatInternalApiKey) {
    headers['x-internal-key'] = chatInternalApiKey;
  }
  const response = await fetch(`${chatServiceUrl}/internal/notify/publish`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`notify publish failed: ${response.status} ${text}`);
  }
}

async function createNotification({
  userId,
  type,
  title,
  body = null,
  deepLink = null,
  payload = null,
  client = pool
}) {
  const inserted = await client.query(
    `INSERT INTO notification (user_id, type, title, body, deep_link, payload)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6::jsonb, '{}'::jsonb))
     RETURNING id, user_id, type, status, title, body, deep_link, payload, created_at, read_at, archived_at`,
    [
      userId,
      type,
      title,
      body,
      deepLink,
      payload ? JSON.stringify(payload) : null
    ]
  );
  return sanitizeNotificationRow(inserted.rows[0]);
}

async function pushNotification(notification) {
  if (!notification?.userId) {
    return;
  }
  await publishNotifyEvent(notification.userId, 'notification.created', {
    notification
  });
}

async function delegateChatHistory(req, method, pathAndQuery, jsonBody) {
  const url = `${chatServiceUrl}${pathAndQuery}`;
  const headers = {
    'X-Delegate-User-Id': req.auth.sub
  };
  if (chatInternalApiKey) {
    headers['x-internal-key'] = chatInternalApiKey;
  }
  const opts = { method, headers };
  if (method === 'POST' || method === 'PATCH') {
    headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(jsonBody || {});
  }
  const response = await fetch(url, opts);
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { error: text };
  }
  return { status: response.status, body };
}

async function shadowChatHistoryCompare(roomId, userId, limit, beforeValue, nodeMessages) {
  try {
    const qs = new URLSearchParams({ limit: String(limit) });
    if (beforeValue) {
      qs.set('before', beforeValue);
    }
    const pathAndQuery = `/internal/history/rooms/${encodeURIComponent(roomId)}/messages?${qs.toString()}`;
    const headers = {
      'X-Delegate-User-Id': userId
    };
    if (chatInternalApiKey) {
      headers['x-internal-key'] = chatInternalApiKey;
    }
    const r = await fetch(`${chatServiceUrl}${pathAndQuery}`, { method: 'GET', headers });
    if (!r.ok) {
      return;
    }
    const goData = await r.json();
    const gLen = Array.isArray(goData.messages) ? goData.messages.length : -1;
    if (gLen !== nodeMessages.length) {
      // eslint-disable-next-line no-console
      console.warn('[chat-history-shadow] message count mismatch', {
        roomId,
        node: nodeMessages.length,
        go: gLen
      });
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[chat-history-shadow]', e.message);
  }
}

async function fetchLiveAggregateFromGo(sessionId) {
  const headers = {};
  if (chatInternalApiKey) {
    headers['x-internal-key'] = chatInternalApiKey;
  }
  const r = await fetch(
    `${chatServiceUrl}/internal/live/sessions/${encodeURIComponent(sessionId)}/aggregate`,
    { headers }
  );
  if (!r.ok) {
    return null;
  }
  return r.json();
}

function liveCreatorPresenceKey(sessionId) {
  return `live:creator:presence:${sessionId}`;
}

async function hasLiveCreatorPresence(sessionId) {
  try {
    await ensureRedisConnected();
    const value = await redisClient.get(liveCreatorPresenceKey(sessionId));
    return Boolean(value);
  } catch (error) {
    return true;
  }
}

async function getLiveCreatorPresenceMap(sessionIds) {
  const map = new Map();
  for (const sessionId of sessionIds) {
    map.set(sessionId, true);
  }
  if (sessionIds.length === 0) {
    return map;
  }

  try {
    await ensureRedisConnected();
    const values = await redisClient.mGet(sessionIds.map((sessionId) => liveCreatorPresenceKey(sessionId)));
    sessionIds.forEach((sessionId, index) => {
      map.set(sessionId, Boolean(values[index]));
    });
  } catch (error) {
    return map;
  }

  return map;
}

async function touchLiveCreatorPresence(sessionId, creatorUserId) {
  try {
    await ensureRedisConnected();
    await redisClient.set(
      liveCreatorPresenceKey(sessionId),
      JSON.stringify({
        creatorUserId,
        touchedAt: new Date().toISOString()
      }),
      { EX: liveCreatorPresenceTtlSeconds }
    );
    return true;
  } catch (error) {
    return false;
  }
}

async function clearLiveCreatorPresence(sessionId) {
  try {
    await ensureRedisConnected();
    await redisClient.del(liveCreatorPresenceKey(sessionId));
  } catch (error) {
    // best effort
  }
}

async function getLiveSessionById(sessionId, viewerUserId = null, db = pool) {
  const result = await db.query(
    `SELECT ls.*,
            cp.user_id AS creator_user_id,
            cp.stage_name,
            ua.username,
            ua.display_name,
            ua.avatar_url,
            COALESCE(viewers.active_viewer_count, 0)::int AS active_viewer_count,
            v.id AS viewer_record_id,
            v.joined_at AS viewer_joined_at,
            v.left_at AS viewer_left_at,
            v.watch_expires_at AS viewer_watch_expires_at,
            v.is_active AS viewer_is_active
     FROM live_session ls
     INNER JOIN creator_profile cp
       ON cp.id = ls.creator_id
     INNER JOIN user_account ua
       ON ua.id = cp.user_id
     LEFT JOIN LATERAL (
       SELECT COUNT(*)::int AS active_viewer_count
       FROM live_session_viewer
       WHERE live_session_id = ls.id
         AND is_active = TRUE
     ) viewers ON TRUE
     LEFT JOIN live_session_viewer v
       ON v.live_session_id = ls.id
      AND v.viewer_user_id = $2::uuid
     WHERE ls.id = $1
     LIMIT 1`,
    [sessionId, viewerUserId]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];
  return {
    stream: sanitizeLiveSession(row),
    viewerAccess: viewerUserId
      ? {
          isCreator: row.creator_user_id === viewerUserId,
          hasJoined: Boolean(row.viewer_record_id),
          isActive: Boolean(row.viewer_is_active),
          joinedAt: row.viewer_joined_at,
          leftAt: row.viewer_left_at,
          watchExpiresAt: row.viewer_watch_expires_at
        }
      : undefined
  };
}

async function endLiveSessionById(sessionId, options = {}) {
  const {
    client: providedClient = null,
    reason = 'creator_ended',
    viewerUserId = null
  } = options;

  const client = providedClient || await pool.connect();
  const ownsTransaction = !providedClient;
  let committed = false;

  try {
    if (ownsTransaction) {
      await client.query('BEGIN');
    }

    const sessionResult = await client.query(
      `SELECT ls.id, ls.room_id, ls.status
       FROM live_session ls
       WHERE ls.id = $1
       LIMIT 1
       FOR UPDATE`,
      [sessionId]
    );

    if (sessionResult.rows.length === 0) {
      if (ownsTransaction) {
        await client.query('ROLLBACK');
      }
      return null;
    }

    const session = sessionResult.rows[0];
    const transitioned = session.status === 'live';

    if (transitioned) {
      await client.query(
        `UPDATE live_session
         SET status = 'ended',
             ended_at = COALESCE(ended_at, now()),
             updated_at = now()
         WHERE id = $1`,
        [sessionId]
      );

      await client.query(
        `UPDATE live_session_viewer
         SET is_active = FALSE,
             left_at = COALESCE(left_at, now()),
             updated_at = now()
         WHERE live_session_id = $1
           AND is_active = TRUE`,
        [sessionId]
      );

      if (session.room_id) {
        await client.query(
          `UPDATE chat_room
           SET is_active = FALSE,
               updated_at = now()
           WHERE id = $1`,
          [session.room_id]
        );
      }
    }

    const payload = await getLiveSessionById(sessionId, viewerUserId, client);

    if (ownsTransaction) {
      await client.query('COMMIT');
      committed = true;
    }

    if (transitioned && ownsTransaction) {
      await clearLiveCreatorPresence(sessionId);
      if (session.room_id) {
        publishChatEvent(session.room_id, 'live.ended', {
          liveSessionId: sessionId,
          reason
        }).catch((error) => {
          // eslint-disable-next-line no-console
          console.error(error.message);
        });
      }
    }

    return {
      transitioned,
      roomId: session.room_id,
      stream: payload?.stream || null,
      viewerAccess: payload?.viewerAccess
    };
  } catch (error) {
    if (ownsTransaction && !committed) {
      await client.query('ROLLBACK');
    }
    throw error;
  } finally {
    if (!providedClient) {
      client.release();
    }
  }
}

function isLiveKitConfigured() {
  return Boolean(
    livekitUrl
    && livekitApiKey
    && livekitApiSecret
    && livekitApiKey !== 'replace_me'
    && livekitApiSecret !== 'replace_me'
  );
}

function createLiveKitAccessToken({ roomName, identity, name, metadata, grant }) {
  const nowSeconds = Math.floor(Date.now() / 1000);

  return jwt.sign(
    {
      iss: livekitApiKey,
      sub: identity,
      nbf: nowSeconds,
      exp: nowSeconds + livekitTokenTtlSeconds,
      name,
      metadata: metadata ? JSON.stringify(metadata) : undefined,
      video: grant
    },
    livekitApiSecret,
    {
      algorithm: 'HS256',
      jwtid: crypto.randomUUID(),
      header: {
        typ: 'JWT'
      }
    }
  );
}

function buildLiveKitGrant({ roomName, role }) {
  const isHost = role === 'host';

  return {
    room: roomName,
    roomJoin: true,
    roomAdmin: isHost,
    canPublish: isHost,
    canPublishData: isHost,
    canSubscribe: true
  };
}

function buildVideoCallLiveKitGrant(roomName) {
  return {
    room: roomName,
    roomJoin: true,
    roomAdmin: false,
    canPublish: true,
    canPublishData: true,
    canSubscribe: true
  };
}

function issueLiveKitSessionCredentials({ stream, userId, role, displayName }) {
  const participantIdentity = `${role}:${userId}:${stream.id}`;
  const grant = buildLiveKitGrant({
    roomName: stream.livekitRoomName,
    role
  });

  const token = createLiveKitAccessToken({
    roomName: stream.livekitRoomName,
    identity: participantIdentity,
    name: displayName || participantIdentity,
    metadata: {
      appUserId: userId,
      liveSessionId: stream.id,
      roomId: stream.roomId,
      role
    },
    grant
  });

  return {
    url: livekitUrl,
    token,
    roomName: stream.livekitRoomName,
    participantIdentity,
    role,
    grants: grant,
    expiresInSeconds: livekitTokenTtlSeconds
  };
}

function issueVideoCallLiveKitCredentials({ call, userId, role, displayName }) {
  const participantIdentity = `${role}:${userId}:${call.id}`;
  const grant = buildVideoCallLiveKitGrant(call.livekitRoomName);
  const token = createLiveKitAccessToken({
    roomName: call.livekitRoomName,
    identity: participantIdentity,
    name: displayName || participantIdentity,
    metadata: {
      appUserId: userId,
      videoCallSessionId: call.id,
      roomId: call.roomId,
      role
    },
    grant
  });

  return {
    url: livekitUrl,
    token,
    roomName: call.livekitRoomName,
    participantIdentity,
    role,
    grants: grant,
    expiresInSeconds: livekitTokenTtlSeconds
  };
}

async function getVideoCallSessionById(sessionId, db = pool) {
  const result = await db.query(
    `SELECT vcs.*,
            cp.user_id AS creator_user_id,
            cp.stage_name,
            ua.username,
            ua.display_name
     FROM video_call_session vcs
     INNER JOIN creator_profile cp
       ON cp.id = vcs.creator_id
     INNER JOIN user_account ua
       ON ua.id = cp.user_id
     WHERE vcs.id = $1
     LIMIT 1`,
    [sessionId]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];
  return {
    call: sanitizeVideoCallSession(row),
    raw: row
  };
}

async function getCurrentUserProfile(userId, db = pool) {
  const result = await db.query(
    `SELECT id, email, username, display_name, status, created_at
     FROM user_account
     WHERE id = $1
     LIMIT 1`,
    [userId]
  );
  return result.rows[0] || null;
}

v1.post('/auth/register', ...(apiAuthLimiterFlag ? [apiAuthLimiter] : []), async (req, res) => {
  const { email, password, displayName, username } = req.body || {};
  if (!email || !password || !displayName) {
    return res.status(400).json({ error: 'email, password and displayName are required' });
  }

  if (String(password).length < 8) {
    return res.status(400).json({ error: 'password must be at least 8 characters' });
  }

  try {
    const passwordHash = await bcrypt.hash(password, 12);
    const created = await pool.query(
      `INSERT INTO user_account (email, password_hash, display_name, username)
       VALUES ($1, $2, $3, $4)
       RETURNING id, email, username, display_name, status, created_at`,
      [email.trim().toLowerCase(), passwordHash, displayName.trim(), username || null]
    );
    const user = created.rows[0];

    await pool.query(
      `INSERT INTO user_role (user_id, role)
       VALUES ($1, 'user')
       ON CONFLICT (user_id, role) DO NOTHING`,
      [user.id]
    );

    await pool.query(
      `INSERT INTO wallet_account (user_id)
       VALUES ($1)
       ON CONFLICT (user_id) DO NOTHING`,
      [user.id]
    );

    return res.status(201).json({
      user: sanitizeUser(user)
    });
  } catch (error) {
    if (error && error.code === '23505') {
      return res.status(409).json({ error: 'email or username already exists' });
    }
    return res.status(500).json({ error: 'failed to create user' });
  }
});

/**
 * Atomically create user_account + fan role + creator role + creator_profile + wallet, then return
 * session tokens (same shape as login). Use this instead of register + creators/apply so the client
 * is authenticated and the creator row exists in one step.
 */
v1.post('/auth/register/creator', ...(apiAuthLimiterFlag ? [apiAuthLimiter] : []), async (req, res) => {
  const { email, password, displayName, username } = req.body || {};
  const stageName = String(req.body?.stageName || '').trim();
  const about = req.body?.about ? String(req.body.about).trim() : null;
  const categoryTags = Array.isArray(req.body?.categoryTags)
    ? req.body.categoryTags.map((tag) => String(tag).trim()).filter(Boolean)
    : [];
  const isNsfw = req.body?.isNsfw !== undefined ? Boolean(req.body.isNsfw) : true;
  const defaultSubscriptionPriceCredits = Math.max(Number(req.body?.defaultSubscriptionPriceCredits || 0), 0);

  if (!email || !password || !displayName) {
    return res.status(400).json({ error: 'email, password and displayName are required' });
  }
  if (!stageName) {
    return res.status(400).json({ error: 'stageName is required' });
  }
  if (String(password).length < 8) {
    return res.status(400).json({ error: 'password must be at least 8 characters' });
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const created = await client.query(
      `INSERT INTO user_account (email, password_hash, display_name, username)
       VALUES ($1, $2, $3, $4)
       RETURNING id, email, username, display_name, avatar_url, bio, status, created_at`,
      [email.trim().toLowerCase(), passwordHash, displayName.trim(), username || null]
    );
    const user = created.rows[0];

    await client.query(
      `INSERT INTO user_role (user_id, role)
       VALUES ($1, 'user')
       ON CONFLICT (user_id, role) DO NOTHING`,
      [user.id]
    );
    await client.query(
      `INSERT INTO user_role (user_id, role)
       VALUES ($1, 'creator')
       ON CONFLICT (user_id, role) DO NOTHING`,
      [user.id]
    );

    await client.query(
      `INSERT INTO wallet_account (user_id)
       VALUES ($1)
       ON CONFLICT (user_id) DO NOTHING`,
      [user.id]
    );

    const profile = await client.query(
      `INSERT INTO creator_profile (
         user_id, stage_name, about, category_tags, is_nsfw, verification_status, default_subscription_price_credits
       )
       VALUES ($1, $2, $3, $4::text[], $5, 'pending', $6)
       RETURNING *`,
      [user.id, stageName, about, categoryTags, isNsfw, defaultSubscriptionPriceCredits]
    );

    await client.query('COMMIT');

    const session = await issueSessionTokens({
      userId: user.id,
      email: user.email,
      role: 'creator',
      userAgent: req.headers['user-agent'],
      ipAddress: getClientIp(req)
    });

    return res.status(201).json({
      token: session.accessToken,
      refreshToken: session.refreshToken,
      sessionId: session.sessionId,
      user: sanitizeUser(user),
      creatorProfile: sanitizeCreator(profile.rows[0])
    });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error && error.code === '23505') {
      return res.status(409).json({ error: 'email or username already exists' });
    }
    return res.status(500).json({ error: 'failed to create creator account' });
  } finally {
    client.release();
  }
});

v1.post('/auth/login', ...(apiAuthLimiterFlag ? [apiAuthLimiter] : []), async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }

  try {
    const result = await pool.query(
      `SELECT u.id, u.email, u.username, u.display_name, u.status, u.password_hash, u.created_at,
              COALESCE((SELECT ur.role::text
                        FROM user_role ur
                        WHERE ur.user_id = u.id
                        ORDER BY CASE ur.role
                          WHEN 'admin' THEN 1
                          WHEN 'moderator' THEN 2
                          WHEN 'creator' THEN 3
                          ELSE 4 END
                        LIMIT 1), 'user') AS role
       FROM user_account u
       WHERE u.email = $1
       LIMIT 1`,
      [email.trim().toLowerCase()]
    );
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'invalid credentials' });
    }

    const user = result.rows[0];
    if (user.status !== 'active') {
      return res.status(403).json({ error: `user is ${user.status}` });
    }

    const passwordOk = await bcrypt.compare(password, user.password_hash || '');
    if (!passwordOk) {
      return res.status(401).json({ error: 'invalid credentials' });
    }

    await pool.query(
      `UPDATE user_account SET last_login_at = now() WHERE id = $1`,
      [user.id]
    );

    const session = await issueSessionTokens({
      userId: user.id,
      email: user.email,
      role: user.role,
      userAgent: req.headers['user-agent'],
      ipAddress: getClientIp(req)
    });

    return res.json({
      token: session.accessToken,
      refreshToken: session.refreshToken,
      sessionId: session.sessionId,
      user: sanitizeUser(user)
    });
  } catch (error) {
    return res.status(500).json({ error: 'failed to login' });
  }
});

v1.post('/auth/refresh', ...(apiAuthLimiterFlag ? [apiAuthLimiter] : []), async (req, res) => {
  const { refreshToken } = req.body || {};
  if (!refreshToken) {
    return res.status(400).json({ error: 'refreshToken is required' });
  }

  let payload;
  try {
    payload = jwt.verify(refreshToken, refreshTokenSecret);
  } catch (error) {
    return res.status(401).json({ error: 'invalid or expired refresh token' });
  }

  if (!payload.sid || !payload.sub) {
    return res.status(401).json({ error: 'invalid refresh token payload' });
  }

  const refreshTokenHash = hashToken(refreshToken);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sessionResult = await client.query(
      `SELECT id, user_id, status, expires_at, refresh_token_hash
       FROM auth_session
       WHERE id = $1
         AND user_id = $2
       FOR UPDATE`,
      [payload.sid, payload.sub]
    );

    if (sessionResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(401).json({ error: 'refresh session not found' });
    }

    const session = sessionResult.rows[0];
    if (session.status !== 'active' || new Date(session.expires_at) <= new Date()) {
      await client.query('ROLLBACK');
      return res.status(401).json({ error: 'refresh session expired or revoked' });
    }
    if (session.refresh_token_hash !== refreshTokenHash) {
      await client.query('ROLLBACK');
      return res.status(401).json({ error: 'refresh token mismatch' });
    }

    const userResult = await client.query(
      `SELECT u.id, u.email, u.username, u.display_name, u.status, u.created_at,
              COALESCE((SELECT ur.role::text
                        FROM user_role ur
                        WHERE ur.user_id = u.id
                        ORDER BY CASE ur.role
                          WHEN 'admin' THEN 1
                          WHEN 'moderator' THEN 2
                          WHEN 'creator' THEN 3
                          ELSE 4 END
                        LIMIT 1), 'user') AS role
       FROM user_account u
       WHERE u.id = $1
       LIMIT 1`,
      [payload.sub]
    );
    if (userResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(401).json({ error: 'user not found' });
    }

    const user = userResult.rows[0];
    if (user.status !== 'active') {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: `user is ${user.status}` });
    }

    await client.query(
      `UPDATE auth_session
       SET status = 'revoked', revoked_at = now()
       WHERE id = $1`,
      [session.id]
    );

    const newSessionResult = await client.query(
      `INSERT INTO auth_session (user_id, refresh_token_hash, user_agent, ip_address, expires_at, status)
       VALUES ($1, '', $2, $3, now() + ($4)::interval, 'active')
       RETURNING id`,
      [user.id, req.headers['user-agent'] || null, getClientIp(req), refreshTokenTtl]
    );
    const newSessionId = newSessionResult.rows[0].id;

    const accessToken = jwt.sign(
      { sub: user.id, email: user.email, role: user.role, typ: 'access' },
      accessTokenSecret,
      { expiresIn: accessTokenTtl }
    );
    const newRefreshToken = jwt.sign(
      { sub: user.id, sid: newSessionId, typ: 'refresh' },
      refreshTokenSecret,
      { expiresIn: refreshTokenTtl }
    );
    const newRefreshTokenHash = hashToken(newRefreshToken);

    await client.query(
      `UPDATE auth_session
       SET refresh_token_hash = $1
       WHERE id = $2`,
      [newRefreshTokenHash, newSessionId]
    );

    await client.query('COMMIT');
    return res.json({
      token: accessToken,
      refreshToken: newRefreshToken,
      sessionId: newSessionId
    });
  } catch (error) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: 'failed to refresh session' });
  } finally {
    client.release();
  }
});

v1.post('/auth/logout', async (req, res) => {
  const { refreshToken } = req.body || {};
  if (!refreshToken) {
    return res.status(400).json({ error: 'refreshToken is required' });
  }

  try {
    const payload = jwt.verify(refreshToken, refreshTokenSecret);
    if (!payload.sid || !payload.sub) {
      return res.status(401).json({ error: 'invalid refresh token payload' });
    }

    const refreshTokenHash = hashToken(refreshToken);
    const revoked = await pool.query(
      `UPDATE auth_session
       SET status = 'revoked', revoked_at = now()
       WHERE id = $1
         AND user_id = $2
         AND refresh_token_hash = $3
         AND status = 'active'`,
      [payload.sid, payload.sub, refreshTokenHash]
    );

    return res.json({ loggedOut: revoked.rowCount > 0 });
  } catch (error) {
    return res.status(401).json({ error: 'invalid or expired refresh token' });
  }
});

v1.get('/auth/me', authRequired, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ua.id, ua.email, ua.username, ua.display_name, ua.avatar_url, ua.bio, ua.status, ua.created_at,
              COALESCE((SELECT ur.role::text
                        FROM user_role ur
                        WHERE ur.user_id = ua.id
                        ORDER BY CASE ur.role
                          WHEN 'admin' THEN 1
                          WHEN 'moderator' THEN 2
                          WHEN 'creator' THEN 3
                          ELSE 4 END
                        LIMIT 1), 'user') AS role
       FROM user_account ua
       WHERE ua.id = $1
       LIMIT 1`,
      [req.auth.sub]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'user not found' });
    }
    const row = result.rows[0];
    const cp = await pool.query(`SELECT * FROM creator_profile WHERE user_id = $1 LIMIT 1`, [req.auth.sub]);
    const creatorProfile = cp.rows.length > 0 ? sanitizeCreator(cp.rows[0]) : null;
    return res.json({
      user: { ...sanitizeUser(row), role: row.role },
      creatorProfile
    });
  } catch (error) {
    return res.status(500).json({ error: 'failed to fetch current user' });
  }
});

v1.get('/users/:id', authRequired, async (req, res) => {
  const userId = req.params.id;

  try {
    const profile = await pool.query(
      `SELECT id, email, username, display_name, avatar_url, bio, status, created_at
       FROM user_account
       WHERE id = $1
       LIMIT 1`,
      [userId]
    );
    if (profile.rows.length === 0) {
      return res.status(404).json({ error: 'user not found' });
    }

    const [followers, following, isFollowing] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS count FROM follow_relation WHERE creator_user_id = $1`, [userId]),
      pool.query(`SELECT COUNT(*)::int AS count FROM follow_relation WHERE follower_user_id = $1`, [userId]),
      pool.query(
        `SELECT 1
         FROM follow_relation
         WHERE follower_user_id = $1
           AND creator_user_id = $2
         LIMIT 1`,
        [req.auth.sub, userId]
      )
    ]);

    const row = profile.rows[0];
    return res.json({
      user: {
        id: row.id,
        email: row.email,
        username: row.username,
        displayName: row.display_name,
        avatarUrl: rewriteStoredMediaUrlToPublicRead(row.avatar_url),
        bio: row.bio,
        status: row.status,
        createdAt: row.created_at
      },
      stats: {
        followers: followers.rows[0].count,
        following: following.rows[0].count,
        isFollowing: isFollowing.rows.length > 0
      }
    });
  } catch (error) {
    return res.status(500).json({ error: 'failed to fetch user' });
  }
});

v1.put('/users/me', authRequired, async (req, res) => {
  const displayName = req.body?.displayName ? String(req.body.displayName).trim() : null;
  const username = req.body?.username ? String(req.body.username).trim().toLowerCase() : null;
  const bio = req.body?.bio !== undefined ? String(req.body.bio).trim() : null;
  const avatarUrl = req.body?.avatarUrl !== undefined ? String(req.body.avatarUrl).trim() : null;

  if (!displayName && username === null && bio === null && avatarUrl === null) {
    return res.status(400).json({ error: 'at least one field is required' });
  }

  try {
    const updated = await pool.query(
      `UPDATE user_account
       SET display_name = COALESCE($1, display_name),
           username = COALESCE($2, username),
           bio = CASE WHEN $3::text IS NULL THEN bio ELSE $3::text END,
           avatar_url = CASE WHEN $4::text IS NULL THEN avatar_url ELSE $4::text END,
           updated_at = now()
       WHERE id = $5
       RETURNING id, email, username, display_name, avatar_url, bio, status, created_at`,
      [displayName, username, bio, avatarUrl, req.auth.sub]
    );
    if (updated.rows.length === 0) {
      return res.status(404).json({ error: 'user not found' });
    }

    const row = updated.rows[0];
    return res.json({
      user: {
        id: row.id,
        email: row.email,
        username: row.username,
        displayName: row.display_name,
        avatarUrl: rewriteStoredMediaUrlToPublicRead(row.avatar_url),
        bio: row.bio,
        status: row.status,
        createdAt: row.created_at
      }
    });
  } catch (error) {
    if (error && error.code === '23505') {
      return res.status(409).json({ error: 'username already taken' });
    }
    return res.status(500).json({ error: 'failed to update profile' });
  }
});

v1.get('/users/:id/followers', authRequired, async (req, res) => {
  const userId = req.params.id;
  const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 100);

  try {
    const result = await pool.query(
      `SELECT ua.id, ua.username, ua.display_name, ua.avatar_url, fr.created_at AS followed_at
       FROM follow_relation fr
       INNER JOIN user_account ua
         ON ua.id = fr.follower_user_id
       WHERE fr.creator_user_id = $1
       ORDER BY fr.created_at DESC
       LIMIT $2`,
      [userId, limit]
    );
    return res.json({ followers: result.rows });
  } catch (error) {
    return res.status(500).json({ error: 'failed to fetch followers' });
  }
});

v1.post('/users/:id/follow', authRequired, async (req, res) => {
  const targetUserId = req.params.id;
  if (targetUserId === req.auth.sub) {
    return res.status(400).json({ error: 'cannot follow yourself' });
  }

  try {
    const actor = await getCurrentUserProfile(req.auth.sub);
    const target = await pool.query(
      `SELECT id
       FROM user_account
       WHERE id = $1
         AND status = 'active'
       LIMIT 1`,
      [targetUserId]
    );
    if (target.rows.length === 0) {
      return res.status(404).json({ error: 'user not found' });
    }

    const inserted = await pool.query(
      `INSERT INTO follow_relation (follower_user_id, creator_user_id)
       VALUES ($1, $2)
       ON CONFLICT (follower_user_id, creator_user_id) DO NOTHING
       RETURNING follower_user_id`,
      [req.auth.sub, targetUserId]
    );
    if (inserted.rows.length > 0) {
      const notification = await createNotification({
        userId: targetUserId,
        type: 'follow',
        title: 'New follower',
        body: `${actor?.display_name || actor?.username || 'Someone'} followed you`,
        deepLink: (await userHasCreatorProfile(targetUserId)) ? '/creator' : '/notifications',
        payload: {
          followerUserId: req.auth.sub
        }
      });
      pushNotification(notification).catch((error) => {
        // eslint-disable-next-line no-console
        console.error(error.message);
      });
    }
    return res.status(201).json({ followed: true });
  } catch (error) {
    return res.status(500).json({ error: 'failed to follow user' });
  }
});

v1.delete('/users/:id/unfollow', authRequired, async (req, res) => {
  const targetUserId = req.params.id;

  try {
    const removed = await pool.query(
      `DELETE FROM follow_relation
       WHERE follower_user_id = $1
         AND creator_user_id = $2`,
      [req.auth.sub, targetUserId]
    );
    return res.json({ unfollowed: removed.rowCount > 0 });
  } catch (error) {
    return res.status(500).json({ error: 'failed to unfollow user' });
  }
});

// Blocking (chat safety)
v1.post('/users/:id/block', authRequired, async (req, res) => {
  const targetUserId = String(req.params.id || '').trim();
  if (!targetUserId) {
    return res.status(400).json({ error: 'target user id is required' });
  }
  if (targetUserId === req.auth.sub) {
    return res.status(400).json({ error: 'cannot block yourself' });
  }

  const reason = req.body?.reason !== undefined ? String(req.body.reason).trim() : null;
  if (reason && reason.length > 500) {
    return res.status(400).json({ error: 'reason is too long' });
  }

  try {
    const target = await pool.query(
      `SELECT id
       FROM user_account
       WHERE id = $1
         AND status = 'active'
       LIMIT 1`,
      [targetUserId]
    );
    if (target.rows.length === 0) {
      return res.status(404).json({ error: 'user not found' });
    }

    await pool.query(
      `INSERT INTO user_block (blocker_user_id, blocked_user_id, reason)
       VALUES ($1, $2, $3)
       ON CONFLICT (blocker_user_id, blocked_user_id) DO NOTHING`,
      [req.auth.sub, targetUserId, reason]
    );

    return res.status(201).json({ blocked: true });
  } catch (error) {
    return res.status(500).json({ error: 'failed to block user' });
  }
});

v1.delete('/users/:id/block', authRequired, async (req, res) => {
  const targetUserId = String(req.params.id || '').trim();
  if (!targetUserId) {
    return res.status(400).json({ error: 'target user id is required' });
  }
  if (targetUserId === req.auth.sub) {
    return res.status(400).json({ error: 'cannot unblock yourself' });
  }

  try {
    const removed = await pool.query(
      `DELETE FROM user_block
       WHERE blocker_user_id = $1
         AND blocked_user_id = $2`,
      [req.auth.sub, targetUserId]
    );
    return res.json({ unblocked: removed.rowCount > 0 });
  } catch (error) {
    return res.status(500).json({ error: 'failed to unblock user' });
  }
});

v1.post('/creators/apply', authRequired, async (req, res) => {
  const stageName = String(req.body?.stageName || '').trim();
  if (!stageName) {
    return res.status(400).json({ error: 'stageName is required' });
  }

  const about = req.body?.about ? String(req.body.about).trim() : null;
  const categoryTags = Array.isArray(req.body?.categoryTags) ? req.body.categoryTags.map((tag) => String(tag).trim()).filter(Boolean) : [];
  const isNsfw = req.body?.isNsfw !== undefined ? Boolean(req.body.isNsfw) : true;
  const defaultSubscriptionPriceCredits = Math.max(Number(req.body?.defaultSubscriptionPriceCredits || 0), 0);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO user_role (user_id, role)
       VALUES ($1, 'creator')
       ON CONFLICT (user_id, role) DO NOTHING`,
      [req.auth.sub]
    );

    const profile = await client.query(
      `INSERT INTO creator_profile (
         user_id, stage_name, about, category_tags, is_nsfw, verification_status, default_subscription_price_credits
       )
       VALUES ($1, $2, $3, $4::text[], $5, 'pending', $6)
       ON CONFLICT (user_id)
       DO UPDATE SET
         stage_name = EXCLUDED.stage_name,
         about = EXCLUDED.about,
         category_tags = EXCLUDED.category_tags,
         is_nsfw = EXCLUDED.is_nsfw,
         default_subscription_price_credits = EXCLUDED.default_subscription_price_credits,
         updated_at = now()
       RETURNING *`,
      [req.auth.sub, stageName, about, categoryTags, isNsfw, defaultSubscriptionPriceCredits]
    );
    await client.query('COMMIT');
    return res.status(201).json({ creator: sanitizeCreator(profile.rows[0]) });
  } catch (error) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: 'failed to apply as creator' });
  } finally {
    client.release();
  }
});

v1.get('/creators/:id', authRequired, async (req, res) => {
  const creatorId = req.params.id;

  try {
    const result = await pool.query(
      `SELECT cp.*, ua.username, ua.display_name, ua.avatar_url, ua.bio
       FROM creator_profile cp
       INNER JOIN user_account ua
         ON ua.id = cp.user_id
       WHERE cp.id = $1
       LIMIT 1`,
      [creatorId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'creator not found' });
    }

    const creator = result.rows[0];
    const [followerCount, subscriberCount] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS count FROM follow_relation WHERE creator_user_id = $1`, [creator.user_id]),
      pool.query(
        `SELECT COUNT(*)::int AS count
         FROM subscription
         WHERE creator_id = $1
           AND status = 'active'
           AND (current_period_end IS NULL OR current_period_end > now())`,
        [creator.id]
      )
    ]);

    return res.json({
      creator: {
        ...sanitizeCreator(creator),
        username: creator.username,
        displayName: creator.display_name,
        avatarUrl: rewriteStoredMediaUrlToPublicRead(creator.avatar_url),
        bio: creator.bio,
        about: mergeCreatorPublicAbout(creator)
      },
      stats: {
        followers: followerCount.rows[0].count,
        subscribers: subscriberCount.rows[0].count
      }
    });
  } catch (error) {
    return res.status(500).json({ error: 'failed to fetch creator profile' });
  }
});

v1.put('/creators/me', authRequired, async (req, res) => {
  const stageName = req.body?.stageName ? String(req.body.stageName).trim() : null;
  const about = req.body?.about !== undefined ? String(req.body.about).trim() : null;
  const categoryTags = Array.isArray(req.body?.categoryTags) ? req.body.categoryTags.map((tag) => String(tag).trim()).filter(Boolean) : null;
  const defaultSubscriptionPriceCredits = req.body?.defaultSubscriptionPriceCredits !== undefined ? Math.max(Number(req.body.defaultSubscriptionPriceCredits), 0) : null;
  const isNsfw = req.body?.isNsfw !== undefined ? Boolean(req.body.isNsfw) : null;
  const liveEnabled = req.body?.liveEnabled !== undefined ? Boolean(req.body.liveEnabled) : null;
  const chatEnabled = req.body?.chatEnabled !== undefined ? Boolean(req.body.chatEnabled) : null;
  const videoCallEnabled = req.body?.videoCallEnabled !== undefined ? Boolean(req.body.videoCallEnabled) : null;

  try {
    await ensureCreatorProfileCompatibilityColumns();
    const updated = await pool.query(
      `UPDATE creator_profile
       SET stage_name = COALESCE($1, stage_name),
           about = CASE WHEN $2::text IS NULL THEN about ELSE $2::text END,
           category_tags = CASE WHEN $3::text[] IS NULL THEN category_tags ELSE $3::text[] END,
           default_subscription_price_credits = COALESCE($4, default_subscription_price_credits),
           is_nsfw = COALESCE($5, is_nsfw),
           live_enabled = COALESCE($6, live_enabled),
           chat_enabled = COALESCE($7, chat_enabled),
           video_call_enabled = COALESCE($8, video_call_enabled),
           updated_at = now()
       WHERE user_id = $9
       RETURNING *`,
      [stageName, about, categoryTags, defaultSubscriptionPriceCredits, isNsfw, liveEnabled, chatEnabled, videoCallEnabled, req.auth.sub]
    );
    if (updated.rows.length === 0) {
      return res.status(404).json({ error: 'creator profile not found' });
    }
    return res.json({ creator: sanitizeCreator(updated.rows[0]) });
  } catch (error) {
    return res.status(500).json({ error: 'failed to update creator profile' });
  }
});

// Creator onboarding / KYC workflow
v1.post('/creators/verification/submit', authRequired, async (req, res) => {
  const mediaAssetIds = Array.isArray(req.body?.mediaAssetIds)
    ? req.body.mediaAssetIds.map((id) => String(id).trim()).filter(Boolean)
    : [];
  const metadata = req.body?.metadata !== undefined ? req.body.metadata : {};

  if (mediaAssetIds.length === 0) {
    return res.status(400).json({ error: 'mediaAssetIds is required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const creator = await client.query(
      `SELECT id
       FROM creator_profile
       WHERE user_id = $1
       LIMIT 1`,
      [req.auth.sub]
    );
    if (creator.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'creator profile required' });
    }

    const ownedMedia = await client.query(
      `SELECT id
       FROM media_asset
       WHERE id = ANY($1::uuid[])
         AND owner_user_id = $2`,
      [mediaAssetIds, req.auth.sub]
    );
    if (ownedMedia.rows.length !== mediaAssetIds.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'all mediaAssetIds must belong to current user' });
    }

    const submission = await client.query(
      `INSERT INTO creator_verification_submission (creator_id, status, metadata)
       VALUES ($1, 'pending', $2::jsonb)
       RETURNING id, creator_id, status, submitted_at, reviewed_at, reviewed_by, metadata`,
      [creator.rows[0].id, JSON.stringify(metadata || {})]
    );

    const submissionId = submission.rows[0].id;
    for (let i = 0; i < mediaAssetIds.length; i += 1) {
      await client.query(
        `INSERT INTO creator_verification_submission_media (creator_verification_submission_id, media_asset_id, sort_order)
         VALUES ($1, $2, $3)
         ON CONFLICT (creator_verification_submission_id, media_asset_id) DO NOTHING`,
        [submissionId, mediaAssetIds[i], i]
      );
    }

    await client.query(
      `UPDATE creator_profile
       SET verification_status = 'pending',
           verified_at = NULL,
           verified_by = NULL,
           updated_at = now()
       WHERE id = $1`,
      [creator.rows[0].id]
    );

    await client.query('COMMIT');
    return res.status(201).json({ submission: submission.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: 'failed to submit verification' });
  } finally {
    client.release();
  }
});

v1.get('/creators/verification/status', authRequired, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT cp.verification_status,
              cp.verified_at,
              cp.verified_by,
              s.id AS submission_id,
              s.status AS submission_status,
              s.submitted_at,
              s.reviewed_at,
              s.reviewed_by,
              s.metadata
       FROM creator_profile cp
       LEFT JOIN LATERAL (
         SELECT id, status, submitted_at, reviewed_at, reviewed_by, metadata
         FROM creator_verification_submission
         WHERE creator_id = cp.id
         ORDER BY submitted_at DESC
         LIMIT 1
       ) s ON TRUE
       WHERE cp.user_id = $1
       LIMIT 1`,
      [req.auth.sub]
    );

    if (result.rows.length === 0) {
      return res.status(403).json({ error: 'creator profile required' });
    }

    const row = result.rows[0];
    return res.json({
      verificationStatus: row.verification_status,
      verifiedAt: row.verified_at,
      verifiedBy: row.verified_by,
      submission: row.submission_id
        ? {
            id: row.submission_id,
            status: row.submission_status,
            submittedAt: row.submitted_at,
            reviewedAt: row.reviewed_at,
            reviewedBy: row.reviewed_by,
            metadata: row.metadata
          }
        : null
    });
  } catch (error) {
    return res.status(500).json({ error: 'failed to fetch verification status' });
  }
});

v1.post('/creators/subscription', authRequired, async (req, res) => {
  if (!allowFreeSubscription) {
    return res.status(403).json({
      error:
        'free subscription path disabled; use POST /api/v1/payments/subscribe with credits, or set ALLOW_FREE_SUBSCRIPTION=1 for development'
    });
  }

  const creatorId = String(req.body?.creatorId || '').trim();
  if (!creatorId) {
    return res.status(400).json({ error: 'creatorId is required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const creatorResult = await client.query(
      `SELECT cp.id, cp.user_id
       FROM creator_profile cp
       WHERE cp.id = $1
       LIMIT 1`,
      [creatorId]
    );
    if (creatorResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'creator not found' });
    }

    const creator = creatorResult.rows[0];
    if (creator.user_id === req.auth.sub) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'cannot subscribe to yourself' });
    }

    const subscription = await client.query(
      `INSERT INTO subscription (
         subscriber_user_id, creator_id, status, started_at, current_period_start, current_period_end, renewal_enabled
       )
       VALUES ($1, $2, 'active', now(), now(), now() + interval '30 days', TRUE)
       ON CONFLICT (subscriber_user_id, creator_id)
       DO UPDATE SET
         status = 'active',
         current_period_start = now(),
         current_period_end = now() + interval '30 days',
         cancelled_at = NULL,
         renewal_enabled = TRUE,
         updated_at = now()
       RETURNING id, subscriber_user_id, creator_id, status, current_period_start, current_period_end, renewal_enabled, created_at, updated_at`,
      [req.auth.sub, creator.id]
    );

    await client.query('COMMIT');
    return res.status(201).json({ subscription: subscription.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: 'failed to subscribe' });
  } finally {
    client.release();
  }
});

v1.get('/creators/:id/subscription', authRequired, async (req, res) => {
  const creatorId = req.params.id;

  try {
    const result = await pool.query(
      `SELECT id, subscriber_user_id, creator_id, status, started_at, current_period_start, current_period_end, cancelled_at, renewal_enabled
       FROM subscription
       WHERE subscriber_user_id = $1
         AND creator_id = $2
       LIMIT 1`,
      [req.auth.sub, creatorId]
    );
    if (result.rows.length === 0) {
      return res.json({ subscribed: false });
    }
    const subscription = result.rows[0];
    const isActive = subscription.status === 'active' && (!subscription.current_period_end || new Date(subscription.current_period_end) > new Date());
    return res.json({ subscribed: isActive, subscription });
  } catch (error) {
    return res.status(500).json({ error: 'failed to fetch subscription' });
  }
});

v1.delete('/creators/:id/subscription', authRequired, async (req, res) => {
  const creatorId = req.params.id;

  try {
    const cancelled = await pool.query(
      `UPDATE subscription
       SET status = 'cancelled',
           cancelled_at = now(),
           renewal_enabled = FALSE,
           updated_at = now()
       WHERE subscriber_user_id = $1
         AND creator_id = $2
         AND status = 'active'
       RETURNING id`,
      [req.auth.sub, creatorId]
    );
    return res.json({ cancelled: cancelled.rows.length > 0 });
  } catch (error) {
    return res.status(500).json({ error: 'failed to cancel subscription' });
  }
});

/** Unauthenticated: redirect to short-lived presigned MinIO GET (works without public bucket policy). */
v1.get('/media/public-read', (req, res) => {
  const bucket = String(req.query.bucket || '').trim();
  const key = String(req.query.key || '').trim();
  if (!bucket || !key || bucket !== minioBucket || !PUBLIC_MEDIA_KEY_RE.test(key)) {
    return res.status(400).json({ error: 'invalid media reference' });
  }

  // Proxy bytes instead of redirecting to the presigned MinIO URL.
  // This prevents the browser from receiving a direct downloadable MinIO link.
  let presigned;
  let browserReachablePresigned;
  try {
    presigned = createMinioPresignedGetUrl({ objectKey: key, expiresSeconds: 3600, forServerFetch: true });
    browserReachablePresigned = createMinioPresignedGetUrl({ objectKey: key, expiresSeconds: 3600 });
  } catch (e) {
    return res.status(500).json({ error: 'failed to sign download' });
  }

  const target = new URL(presigned);
  const lib = target.protocol === 'https:' ? https : http;
  const port = target.port ? Number(target.port) : target.protocol === 'https:' ? 443 : 80;

  const upstreamReq = lib.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port,
      path: `${target.pathname}${target.search}`,
      method: 'GET'
    },
    (upRes) => {
      const pass = ['content-type', 'content-length', 'etag', 'last-modified'];
      res.status(upRes.statusCode || 200);
      pass.forEach((h) => {
        const v = upRes.headers[h];
        if (v) res.setHeader(h, v);
      });
      res.setHeader('Content-Disposition', 'inline');
      // Ensure the presigned response is not cached in a way that encourages reuse/downloading.
      res.setHeader('Cache-Control', 'no-store, private, max-age=0, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      upRes.pipe(res);
    }
  );

  upstreamReq.on('error', (err) => {
    if (!res.headersSent) {
      if (browserReachablePresigned) {
        return res.redirect(302, browserReachablePresigned);
      }
      return res.status(502).json({ error: 'media upstream failed' });
    }
    res.end();
  });
  upstreamReq.end();
});

/**
 * Same auth rules as public-read, but proxies bytes (forwards Range). HTML5 video breaks on 302 + Range to MinIO.
 */
v1.get('/media/public-stream', (req, res) => {
  const bucket = String(req.query.bucket || '').trim();
  const key = String(req.query.key || '').trim();
  if (!bucket || !key || bucket !== minioBucket || !PUBLIC_MEDIA_KEY_RE.test(key)) {
    return res.status(400).json({ error: 'invalid media reference' });
  }
  let presigned;
  try {
    presigned = createMinioPresignedGetUrl({ objectKey: key, expiresSeconds: 3600, forServerFetch: true });
  } catch (e) {
    return res.status(500).json({ error: 'failed to sign download' });
  }

  const target = new URL(presigned);
  const lib = target.protocol === 'https:' ? https : http;
  const port = target.port ? Number(target.port) : target.protocol === 'https:' ? 443 : 80;
  const fwd = {};
  if (req.headers.range) fwd.Range = req.headers.range;
  if (req.headers['if-range']) fwd['If-Range'] = req.headers['if-range'];
  if (req.headers['if-none-match']) fwd['If-None-Match'] = req.headers['if-none-match'];
  if (req.headers['if-modified-since']) fwd['If-Modified-Since'] = req.headers['if-modified-since'];

  const upstreamReq = lib.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port,
      path: `${target.pathname}${target.search}`,
      method: 'GET',
      headers: fwd
    },
    (upRes) => {
      const pass = [
        'content-type',
        'content-length',
        'content-range',
        'accept-ranges',
        'etag',
        'last-modified',
        'cache-control'
      ];
      const code = upRes.statusCode || 502;
      res.status(code);
      pass.forEach((h) => {
        const v = upRes.headers[h];
        if (v) res.setHeader(h, v);
      });
      res.setHeader('Content-Disposition', 'inline');
      res.setHeader('Cache-Control', 'no-store, private, max-age=0, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      upRes.pipe(res);
    }
  );

  upstreamReq.on('error', (err) => {
    if (process.env.NODE_ENV !== 'test') {
      console.error('[media/public-stream] upstream error', err?.message || err);
    }
    if (!res.headersSent) res.status(502).json({ error: 'media upstream failed' });
    else res.end();
  });
  req.on('aborted', () => upstreamReq.destroy());
  upstreamReq.end();
});

v1.post('/media/upload-url', authRequired, async (req, res) => {
  const objectKey = `uploads/${req.auth.sub}/${crypto.randomUUID()}`;
  const contentType = String(req.body?.contentType || req.query?.contentType || 'application/octet-stream');
  let uploadUrl;
  try {
    uploadUrl = createMinioPresignedPutUrl({
      objectKey,
      contentType,
      expiresSeconds: 900
    });
  } catch (error) {
    return res.status(500).json({ error: 'failed to create presigned upload URL', details: error.message });
  }
  return res.json({
    objectKey,
    uploadUrl,
    expiresInSeconds: 900,
    storageBucket: minioBucket,
    storageProvider: minioStorageProvider
  });
});

v1.post('/media/complete', authRequired, async (req, res) => {
  const mediaType = String(req.body?.mediaType || '').trim();
  const objectKey = String(req.body?.objectKey || '').trim();
  if (!mediaType || !objectKey) {
    return res.status(400).json({ error: 'mediaType and objectKey are required' });
  }

  const allowedMediaTypes = new Set(['image', 'video', 'audio', 'document']);
  if (!allowedMediaTypes.has(mediaType)) {
    return res.status(400).json({ error: 'invalid mediaType' });
  }

  const storageProvider = req.body?.storageProvider
    ? String(req.body.storageProvider).trim()
    : minioStorageProvider;
  const storageBucket = req.body?.storageBucket
    ? String(req.body.storageBucket).trim()
    : minioBucket;

  try {
    const inserted = await pool.query(
      `INSERT INTO media_asset (
         owner_user_id, media_type, storage_provider, storage_bucket, object_key,
         original_filename, mime_type, byte_size, width, height, duration_seconds, is_public, metadata
       )
       VALUES ($1, $2::media_type, COALESCE($3, 's3'), $4, $5, $6, $7, $8, $9, $10, $11, COALESCE($12, FALSE), COALESCE($13::jsonb, '{}'::jsonb))
       RETURNING id, owner_user_id, media_type, storage_provider, storage_bucket, object_key, original_filename, mime_type, byte_size, width, height, duration_seconds, is_public, metadata, created_at`,
      [
        req.auth.sub,
        mediaType,
        storageProvider || null,
        storageBucket || null,
        objectKey,
        req.body?.originalFilename ? String(req.body.originalFilename).trim() : null,
        req.body?.mimeType ? String(req.body.mimeType).trim() : null,
        req.body?.byteSize ? Number(req.body.byteSize) : null,
        req.body?.width ? Number(req.body.width) : null,
        req.body?.height ? Number(req.body.height) : null,
        req.body?.durationSeconds ? Number(req.body.durationSeconds) : null,
        req.body?.isPublic !== undefined ? Boolean(req.body.isPublic) : false,
        req.body?.metadata ? JSON.stringify(req.body.metadata) : null
      ]
    );
    return res.status(201).json({ media: inserted.rows[0] });
  } catch (error) {
    return res.status(500).json({ error: 'failed to complete media upload' });
  }
});

v1.get('/media/:id', authRequired, async (req, res) => {
  const mediaId = req.params.id;

  try {
    const result = await pool.query(
      `SELECT id, owner_user_id, media_type, storage_provider, storage_bucket, object_key, original_filename, mime_type, byte_size, width, height, duration_seconds, is_public, metadata, created_at
       FROM media_asset
       WHERE id = $1
       LIMIT 1`,
      [mediaId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'media not found' });
    }
    const media = result.rows[0];
    if (media.is_public || media.owner_user_id === req.auth.sub) {
      return res.json({ media });
    }

    const posts = await pool.query(
      `SELECT cp.*, c.user_id AS creator_user_id
       FROM content_post_media cpm
       INNER JOIN content_post cp ON cp.id = cpm.content_post_id
       INNER JOIN creator_profile c ON c.id = cp.creator_id
       WHERE cpm.media_asset_id = $1`,
      [mediaId]
    );
    for (const row of posts.rows) {
      if (await userCanViewContentPost(req.auth.sub, row)) {
        return res.json({ media });
      }
    }

    const subExclusive = await pool.query(
      `SELECT sec.*, c.user_id AS creator_user_id
       FROM subscription_exclusive_content_media secm
       INNER JOIN subscription_exclusive_content sec ON sec.id = secm.subscription_exclusive_content_id
       INNER JOIN creator_profile c ON c.id = sec.creator_id
       WHERE secm.media_asset_id = $1`,
      [mediaId]
    );
    for (const row of subExclusive.rows) {
      const isOwner = row.creator_user_id === req.auth.sub;
      if (isOwner) {
        return res.json({ media });
      }
      if (row.status === 'published' && (await hasActiveSubscription(req.auth.sub, row.creator_id))) {
        return res.json({ media });
      }
    }

    return res.status(403).json({ error: 'forbidden' });
  } catch (error) {
    return res.status(500).json({ error: 'failed to fetch media' });
  }
});

v1.delete('/media/:id', authRequired, async (req, res) => {
  const mediaId = req.params.id;

  try {
    const used = await pool.query(
      `SELECT 1
       FROM content_post_media
       WHERE media_asset_id = $1
       LIMIT 1`,
      [mediaId]
    );
    if (used.rows.length > 0) {
      return res.status(409).json({ error: 'media is attached to content; remove it from posts first' });
    }
    const usedSub = await pool.query(
      `SELECT 1
       FROM subscription_exclusive_content_media
       WHERE media_asset_id = $1
       LIMIT 1`,
      [mediaId]
    );
    if (usedSub.rows.length > 0) {
      return res.status(409).json({ error: 'media is attached to subscription content; remove it first' });
    }

    const removed = await pool.query(
      `DELETE FROM media_asset
       WHERE id = $1 AND owner_user_id = $2
       RETURNING id`,
      [mediaId, req.auth.sub]
    );
    if (removed.rows.length === 0) {
      return res.status(404).json({ error: 'media not found' });
    }
    return res.json({ deleted: true, mediaId });
  } catch (error) {
    return res.status(500).json({ error: 'failed to delete media' });
  }
});

v1.post('/content/upload-url', authRequired, async (req, res) => {
  const objectKey = `content/${req.auth.sub}/${crypto.randomUUID()}`;
  const contentType = String(req.body?.contentType || req.query?.contentType || 'application/octet-stream');
  let uploadUrl;
  try {
    uploadUrl = createMinioPresignedPutUrl({
      objectKey,
      contentType,
      expiresSeconds: 900
    });
  } catch (error) {
    return res.status(500).json({ error: 'failed to create presigned upload URL', details: error.message });
  }
  return res.json({
    objectKey,
    uploadUrl,
    expiresInSeconds: 900,
    storageBucket: minioBucket,
    storageProvider: minioStorageProvider
  });
});

v1.post('/content', authRequired, async (req, res) => {
  const visibility = String(req.body?.visibility || 'subscribers').trim();
  const status = String(req.body?.status || 'draft').trim();
  const requiresPayment = Boolean(req.body?.requiresPayment || false);
  const unlockPriceCredits = requiresPayment ? Number(req.body?.unlockPriceCredits || 0) : 0;
  const mediaAssetIds = Array.isArray(req.body?.mediaAssetIds) ? req.body.mediaAssetIds.map((id) => String(id).trim()).filter(Boolean) : [];

  const allowedVisibility = new Set(['public', 'followers', 'subscribers', 'exclusive_ppv', 'private']);
  const allowedStatus = new Set(['draft', 'published', 'archived', 'deleted']);
  if (!allowedVisibility.has(visibility)) {
    return res.status(400).json({ error: 'invalid visibility' });
  }
  if (!allowedStatus.has(status)) {
    return res.status(400).json({ error: 'invalid status' });
  }
  if (requiresPayment && unlockPriceCredits <= 0) {
    return res.status(400).json({ error: 'unlockPriceCredits must be > 0 when requiresPayment is true' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const creator = await client.query(
      `SELECT id
       FROM creator_profile
       WHERE user_id = $1
       LIMIT 1`,
      [req.auth.sub]
    );
    if (creator.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'creator profile required' });
    }

    const created = await client.query(
      `INSERT INTO content_post (
         creator_id, title, caption, visibility, status, requires_payment, unlock_price_credits, published_at, metadata
       )
       VALUES (
         $1, $2, $3, $4::content_visibility, $5::content_status, $6, $7,
         CASE WHEN $5 = 'published' THEN now() ELSE NULL END,
         COALESCE($8::jsonb, '{}'::jsonb)
       )
       RETURNING *`,
      [
        creator.rows[0].id,
        req.body?.title ? String(req.body.title).trim() : null,
        req.body?.caption ? String(req.body.caption).trim() : null,
        visibility,
        status,
        requiresPayment,
        unlockPriceCredits,
        req.body?.metadata ? JSON.stringify(req.body.metadata) : null
      ]
    );

    const content = created.rows[0];
    if (mediaAssetIds.length > 0) {
      const ownedMedia = await client.query(
        `SELECT id
         FROM media_asset
         WHERE id = ANY($1::uuid[])
           AND owner_user_id = $2`,
        [mediaAssetIds, req.auth.sub]
      );
      if (ownedMedia.rows.length !== mediaAssetIds.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'all mediaAssetIds must belong to current user' });
      }

      for (let i = 0; i < mediaAssetIds.length; i += 1) {
        await client.query(
          `INSERT INTO content_post_media (content_post_id, media_asset_id, sort_order)
           VALUES ($1, $2, $3)
           ON CONFLICT (content_post_id, media_asset_id) DO NOTHING`,
          [content.id, mediaAssetIds[i], i]
        );
      }
    }

    await client.query('COMMIT');
    return res.status(201).json({ content: sanitizeContent(content) });
  } catch (error) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: 'failed to create content' });
  } finally {
    client.release();
  }
});

v1.get('/content/:id', authRequired, async (req, res) => {
  const contentId = req.params.id;

  try {
    const result = await pool.query(
      `SELECT cp.*, c.user_id AS creator_user_id
       FROM content_post cp
       INNER JOIN creator_profile c ON c.id = cp.creator_id
       WHERE cp.id = $1
       LIMIT 1`,
      [contentId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'content not found' });
    }
    const content = result.rows[0];

    const hasAccess = await userCanViewContentPost(req.auth.sub, content);
    if (!hasAccess) {
      return res.status(403).json({ error: 'forbidden' });
    }

    const media = await pool.query(
      `SELECT ma.id, ma.media_type, ma.storage_provider, ma.storage_bucket, ma.object_key, ma.original_filename, ma.mime_type, ma.byte_size, ma.width, ma.height, ma.duration_seconds, ma.is_public, ma.metadata, ma.created_at
       FROM content_post_media cpm
       INNER JOIN media_asset ma ON ma.id = cpm.media_asset_id
       WHERE cpm.content_post_id = $1
       ORDER BY cpm.sort_order ASC, cpm.created_at ASC`,
      [content.id]
    );

    return res.json({
      content: sanitizeContent(content),
      media: media.rows
    });
  } catch (error) {
    return res.status(500).json({ error: 'failed to fetch content' });
  }
});

v1.patch('/content/:id', authRequired, async (req, res) => {
  const contentId = req.params.id;
  const allowedVisibility = new Set(['public', 'followers', 'subscribers', 'exclusive_ppv', 'private']);
  const allowedStatus = new Set(['draft', 'published', 'archived', 'deleted']);

  if (req.body === null || typeof req.body !== 'object') {
    return res.status(400).json({ error: 'invalid body' });
  }

  const canPatch = [
    'title',
    'caption',
    'visibility',
    'status',
    'requiresPayment',
    'unlockPriceCredits',
    'metadata'
  ].some((k) => Object.prototype.hasOwnProperty.call(req.body, k));
  if (!canPatch) {
    return res.status(400).json({ error: 'no valid fields to update' });
  }

  try {
    const cur = await pool.query(
      `SELECT cp.*
       FROM content_post cp
       INNER JOIN creator_profile c ON c.id = cp.creator_id
       WHERE cp.id = $1 AND c.user_id = $2`,
      [contentId, req.auth.sub]
    );
    if (cur.rows.length === 0) {
      return res.status(404).json({ error: 'content not found' });
    }
    const row = cur.rows[0];

    let title = row.title;
    if (req.body.title !== undefined) {
      title = req.body.title === null ? null : String(req.body.title).trim();
    }
    let caption = row.caption;
    if (req.body.caption !== undefined) {
      caption = req.body.caption === null ? null : String(req.body.caption).trim();
    }
    let visibility = row.visibility;
    if (req.body.visibility !== undefined) {
      const v = String(req.body.visibility || '').trim();
      if (!allowedVisibility.has(v)) {
        return res.status(400).json({ error: 'invalid visibility' });
      }
      visibility = v;
    }
    let status = row.status;
    if (req.body.status !== undefined) {
      const s = String(req.body.status || '').trim();
      if (!allowedStatus.has(s)) {
        return res.status(400).json({ error: 'invalid status' });
      }
      status = s;
    }
    let requiresPayment = row.requires_payment;
    if (req.body.requiresPayment !== undefined) {
      requiresPayment = Boolean(req.body.requiresPayment);
    }
    let unlockPriceCredits = Number(row.unlock_price_credits || 0);
    if (req.body.unlockPriceCredits !== undefined) {
      unlockPriceCredits = Math.max(0, Number(req.body.unlockPriceCredits) || 0);
    }
    if (!requiresPayment) {
      unlockPriceCredits = 0;
    } else if (unlockPriceCredits <= 0) {
      return res.status(400).json({ error: 'unlockPriceCredits must be > 0 when requiresPayment is true' });
    }

    let metadata = row.metadata;
    if (req.body.metadata !== undefined) {
      metadata = req.body.metadata === null ? {} : req.body.metadata;
    }

    const updated = await pool.query(
      `UPDATE content_post
       SET title = $1,
           caption = $2,
           visibility = $3::content_visibility,
           status = $4::content_status,
           requires_payment = $5,
           unlock_price_credits = $6,
           metadata = COALESCE($7::jsonb, '{}'::jsonb),
           published_at = CASE
             WHEN $4::content_status = 'published' AND published_at IS NULL THEN now()
             ELSE published_at
           END,
           updated_at = now()
       WHERE id = $8
       RETURNING *`,
      [
        title,
        caption,
        visibility,
        status,
        requiresPayment,
        unlockPriceCredits,
        JSON.stringify(metadata),
        contentId
      ]
    );

    return res.json({ content: sanitizeContent(updated.rows[0]) });
  } catch (error) {
    return res.status(500).json({ error: 'failed to update content' });
  }
});

v1.post('/content/:id/unlock', authRequired, async (req, res) => {
  const contentId = req.params.id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `SELECT cp.*, c.user_id AS creator_user_id
       FROM content_post cp
       INNER JOIN creator_profile c ON c.id = cp.creator_id
       WHERE cp.id = $1
       LIMIT 1
       FOR UPDATE`,
      [contentId]
    );
    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'content not found' });
    }
    const content = result.rows[0];
    if (content.creator_user_id === req.auth.sub) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'owner does not need to unlock' });
    }
    if (content.status !== 'published' || content.visibility !== 'exclusive_ppv' || !content.requires_payment) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'content is not unlockable via PPV' });
    }
    const price = Number(content.unlock_price_credits || 0);
    if (price <= 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'invalid unlock price' });
    }

    if (await userCanViewContentPost(req.auth.sub, content)) {
      await client.query('COMMIT');
      return res.status(200).json({ alreadyUnlocked: true, content: sanitizeContent(content) });
    }

    await ensureWallet(client, req.auth.sub);
    await ensureWallet(client, content.creator_user_id);

    const transfer = await transferCredits({
      client,
      fromUserId: req.auth.sub,
      toUserId: content.creator_user_id,
      amountCredits: price,
      debitEntryType: 'content_unlock_debit',
      creditEntryType: 'content_unlock_credit',
      referenceType: 'content_unlock',
      referenceId: content.id
    });

    await client.query(
      `INSERT INTO content_access_grant (content_post_id, granted_to_user_id, grant_source, granted_by_user_id)
       VALUES ($1, $2, 'ppv_unlock', NULL)
       ON CONFLICT (content_post_id, granted_to_user_id)
       DO UPDATE SET grant_source = EXCLUDED.grant_source, created_at = now()`,
      [content.id, req.auth.sub]
    );

    await client.query('COMMIT');
    return res.status(201).json({ content: sanitizeContent(content), transfer });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error && error.code === 'INSUFFICIENT_CREDITS') {
      return res.status(402).json({ error: 'insufficient credits to unlock' });
    }
    return res.status(500).json({ error: 'failed to unlock content' });
  } finally {
    client.release();
  }
});

v1.delete('/content/:id', authRequired, async (req, res) => {
  const contentId = req.params.id;

  try {
    const removed = await pool.query(
      `DELETE FROM content_post cp
       USING creator_profile c
       WHERE cp.id = $1
         AND cp.creator_id = c.id
         AND c.user_id = $2
       RETURNING cp.id`,
      [contentId, req.auth.sub]
    );
    if (removed.rows.length === 0) {
      return res.status(404).json({ error: 'content not found' });
    }
    return res.json({ deleted: true, contentId });
  } catch (error) {
    return res.status(500).json({ error: 'failed to delete content' });
  }
});

v1.get('/creators/:id/content', authRequired, async (req, res) => {
  const creatorId = req.params.id;
  const limit = Math.min(Math.max(Number(req.query.limit || 20), 1), 100);

  try {
    const creator = await pool.query(
      `SELECT id, user_id
       FROM creator_profile
       WHERE id = $1
       LIMIT 1`,
      [creatorId]
    );
    if (creator.rows.length === 0) {
      return res.status(404).json({ error: 'creator not found' });
    }

    const isOwner = creator.rows[0].user_id === req.auth.sub;
    const result = await pool.query(
      `SELECT id, creator_id, title, caption, visibility, status, requires_payment, unlock_price_credits, published_at, scheduled_for, metadata, created_at, updated_at
       FROM content_post
       WHERE creator_id = $1
         AND ($2::boolean = TRUE OR status = 'published')
         AND ($4::boolean = FALSE OR $2::boolean = TRUE OR EXISTS (
           SELECT 1
           FROM subscription s
           WHERE s.subscriber_user_id = $5::uuid
             AND s.creator_id = content_post.creator_id
             AND s.status = 'active'
             AND (s.current_period_end IS NULL OR s.current_period_end > now())
         ))
       ORDER BY COALESCE(published_at, created_at) DESC
       LIMIT $3`,
      [creatorId, isOwner, limit, subscribersOnlyCatalog, req.auth.sub]
    );

    return res.json({ content: result.rows.map(sanitizeContent) });
  } catch (error) {
    return res.status(500).json({ error: 'failed to fetch creator content' });
  }
});

v1.post('/subscription-content/upload-url', authRequired, async (req, res) => {
  const objectKey = `subscription-content/${req.auth.sub}/${crypto.randomUUID()}`;
  const contentType = String(req.body?.contentType || req.query?.contentType || 'application/octet-stream');
  let uploadUrl;
  try {
    uploadUrl = createMinioPresignedPutUrl({
      objectKey,
      contentType,
      expiresSeconds: 900
    });
  } catch (error) {
    return res.status(500).json({ error: 'failed to create presigned upload URL', details: error.message });
  }
  return res.json({
    objectKey,
    uploadUrl,
    expiresInSeconds: 900,
    storageBucket: minioBucket,
    storageProvider: minioStorageProvider
  });
});

v1.post('/subscription-content', authRequired, async (req, res) => {
  const status = String(req.body?.status || 'draft').trim();
  const mediaAssetIds = Array.isArray(req.body?.mediaAssetIds) ? req.body.mediaAssetIds.map((id) => String(id).trim()).filter(Boolean) : [];
  const allowedStatus = new Set(['draft', 'published', 'archived', 'deleted']);
  if (!allowedStatus.has(status)) {
    return res.status(400).json({ error: 'invalid status' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const creator = await client.query(
      `SELECT id
       FROM creator_profile
       WHERE user_id = $1
       LIMIT 1`,
      [req.auth.sub]
    );
    if (creator.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'creator profile required' });
    }

    const created = await client.query(
      `INSERT INTO subscription_exclusive_content (
         creator_id, title, caption, status, published_at, metadata
       )
       VALUES (
         $1, $2, $3, $4::content_status,
         CASE WHEN $4 = 'published' THEN now() ELSE NULL END,
         COALESCE($5::jsonb, '{}'::jsonb)
       )
       RETURNING *`,
      [
        creator.rows[0].id,
        req.body?.title ? String(req.body.title).trim() : null,
        req.body?.caption ? String(req.body.caption).trim() : null,
        status,
        req.body?.metadata ? JSON.stringify(req.body.metadata) : null
      ]
    );

    const content = created.rows[0];
    if (mediaAssetIds.length > 0) {
      const ownedMedia = await client.query(
        `SELECT id
         FROM media_asset
         WHERE id = ANY($1::uuid[])
           AND owner_user_id = $2`,
        [mediaAssetIds, req.auth.sub]
      );
      if (ownedMedia.rows.length !== mediaAssetIds.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'all mediaAssetIds must belong to current user' });
      }

      for (let i = 0; i < mediaAssetIds.length; i += 1) {
        await client.query(
          `INSERT INTO subscription_exclusive_content_media (subscription_exclusive_content_id, media_asset_id, sort_order)
           VALUES ($1, $2, $3)
           ON CONFLICT (subscription_exclusive_content_id, media_asset_id) DO NOTHING`,
          [content.id, mediaAssetIds[i], i]
        );
      }
    }

    await client.query('COMMIT');
    return res.status(201).json({ content: sanitizeSubscriptionExclusiveContent(content) });
  } catch (error) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: 'failed to create subscription content' });
  } finally {
    client.release();
  }
});

v1.get('/subscription-content/:id', authRequired, async (req, res) => {
  const contentId = req.params.id;

  try {
    const result = await pool.query(
      `SELECT sec.*, c.user_id AS creator_user_id
       FROM subscription_exclusive_content sec
       INNER JOIN creator_profile c ON c.id = sec.creator_id
       WHERE sec.id = $1
       LIMIT 1`,
      [contentId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'subscription content not found' });
    }
    const content = result.rows[0];

    const isOwner = content.creator_user_id === req.auth.sub;
    if (!isOwner) {
      if (content.status !== 'published') {
        return res.status(403).json({ error: 'content is not published' });
      }
      const subscribed = await hasActiveSubscription(req.auth.sub, content.creator_id);
      if (!subscribed) {
        return res.status(403).json({ error: 'active subscription required' });
      }
    }

    const media = await pool.query(
      `SELECT ma.id, ma.media_type, ma.storage_provider, ma.storage_bucket, ma.object_key, ma.original_filename, ma.mime_type, ma.byte_size, ma.width, ma.height, ma.duration_seconds, ma.is_public, ma.metadata, ma.created_at
       FROM subscription_exclusive_content_media secm
       INNER JOIN media_asset ma ON ma.id = secm.media_asset_id
       WHERE secm.subscription_exclusive_content_id = $1
       ORDER BY secm.sort_order ASC, secm.created_at ASC`,
      [content.id]
    );

    return res.json({
      content: sanitizeSubscriptionExclusiveContent(content),
      media: media.rows
    });
  } catch (error) {
    return res.status(500).json({ error: 'failed to fetch subscription content' });
  }
});

v1.patch('/subscription-content/:id', authRequired, async (req, res) => {
  const contentId = req.params.id;

  if (req.body === null || typeof req.body !== 'object') {
    return res.status(400).json({ error: 'invalid body' });
  }

  const canPatch = [
    'title',
    'caption',
    'status',
    'metadata'
  ].some((k) => Object.prototype.hasOwnProperty.call(req.body, k));

  if (!canPatch) {
    return res.status(400).json({ error: 'no valid fields to update' });
  }

  const allowedStatus = new Set(['draft', 'published', 'archived', 'deleted']);
  if (req.body.status !== undefined) {
    const s = String(req.body.status || '').trim();
    if (!allowedStatus.has(s)) {
      return res.status(400).json({ error: 'invalid status' });
    }
  }

  try {
    const cur = await pool.query(
      `SELECT sec.*
       FROM subscription_exclusive_content sec
       INNER JOIN creator_profile c ON c.id = sec.creator_id
       WHERE sec.id = $1
         AND c.user_id = $2
       LIMIT 1`,
      [contentId, req.auth.sub]
    );

    if (cur.rows.length === 0) {
      return res.status(404).json({ error: 'subscription content not found' });
    }

    const row = cur.rows[0];
    const title = req.body.title !== undefined
      ? (req.body.title === null ? null : String(req.body.title).trim())
      : row.title;
    const caption = req.body.caption !== undefined
      ? (req.body.caption === null ? null : String(req.body.caption).trim())
      : row.caption;
    const status = req.body.status !== undefined ? String(req.body.status).trim() : row.status;
    const metadata = req.body.metadata !== undefined
      ? (req.body.metadata === null ? {} : req.body.metadata)
      : row.metadata;

    const publishedAt = status === 'published'
      ? (row.published_at || new Date())
      : null;

    const updated = await pool.query(
      `UPDATE subscription_exclusive_content
       SET title = $1,
           caption = $2,
           status = $3::content_status,
           published_at = $4::timestamptz,
           metadata = COALESCE($5::jsonb, '{}'::jsonb),
           updated_at = now()
       WHERE id = $6
       RETURNING *`,
      [title, caption, status, publishedAt, JSON.stringify(metadata), contentId]
    );

    return res.json({ content: sanitizeSubscriptionExclusiveContent(updated.rows[0]) });
  } catch (error) {
    return res.status(500).json({ error: 'failed to update subscription content' });
  }
});

v1.delete('/subscription-content/:id', authRequired, async (req, res) => {
  const contentId = req.params.id;

  try {
    const removed = await pool.query(
      `DELETE FROM subscription_exclusive_content sec
       USING creator_profile c
       WHERE sec.id = $1
         AND sec.creator_id = c.id
         AND c.user_id = $2
       RETURNING sec.id`,
      [contentId, req.auth.sub]
    );
    if (removed.rows.length === 0) {
      return res.status(404).json({ error: 'subscription content not found' });
    }
    return res.json({ deleted: true, contentId });
  } catch (error) {
    return res.status(500).json({ error: 'failed to delete subscription content' });
  }
});

v1.get('/creators/:id/subscription-content', authRequired, async (req, res) => {
  const creatorId = req.params.id;
  const limit = Math.min(Math.max(Number(req.query.limit || 20), 1), 100);

  try {
    const creator = await pool.query(
      `SELECT id, user_id
       FROM creator_profile
       WHERE id = $1
       LIMIT 1`,
      [creatorId]
    );
    if (creator.rows.length === 0) {
      return res.status(404).json({ error: 'creator not found' });
    }

    const creatorProfile = creator.rows[0];
    const isOwner = creatorProfile.user_id === req.auth.sub;
    const subscribed = isOwner ? true : await hasActiveSubscription(req.auth.sub, creatorProfile.id);
    const result = await pool.query(
      `SELECT id, creator_id, title, caption, status, published_at, metadata, created_at, updated_at
       FROM subscription_exclusive_content
       WHERE creator_id = $1
         AND (
           $2::boolean = TRUE
           OR ($3::boolean = TRUE AND status = 'published')
         )
       ORDER BY COALESCE(published_at, created_at) DESC
       LIMIT $4`,
      [creatorId, isOwner, subscribed, limit]
    );

    return res.json({
      subscribed,
      content: result.rows.map(sanitizeSubscriptionExclusiveContent)
    });
  } catch (error) {
    return res.status(500).json({ error: 'failed to fetch creator subscription content' });
  }
});

v1.get('/feed', authRequired, async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit || 20), 1), 100);

  try {
    const result = await pool.query(
      `SELECT cp.id, cp.creator_id, cp.title, cp.caption, cp.visibility, cp.status, cp.requires_payment, cp.unlock_price_credits, cp.published_at, cp.scheduled_for, cp.metadata, cp.created_at, cp.updated_at
       FROM content_post cp
       INNER JOIN creator_profile c ON c.id = cp.creator_id
       LEFT JOIN follow_relation fr
         ON fr.creator_user_id = c.user_id
        AND fr.follower_user_id = $1::uuid
       WHERE cp.status = 'published'
         AND (
           cp.visibility = 'public'
           OR (cp.visibility = 'followers' AND fr.follower_user_id IS NOT NULL)
         )
         AND ($3::boolean = FALSE OR EXISTS (
           SELECT 1
           FROM subscription s
           WHERE s.subscriber_user_id = $1::uuid
             AND s.creator_id = cp.creator_id
             AND s.status = 'active'
             AND (s.current_period_end IS NULL OR s.current_period_end > now())
         ))
       ORDER BY cp.published_at DESC NULLS LAST, cp.created_at DESC
       LIMIT $2`,
      [req.auth.sub, limit, subscribersOnlyCatalog]
    );
    return res.json({ feed: result.rows.map(sanitizeContent) });
  } catch (error) {
    return res.status(500).json({ error: 'failed to fetch feed' });
  }
});

v1.get('/feed/following', authRequired, async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit || 20), 1), 100);

  try {
    const result = await pool.query(
      `SELECT cp.id, cp.creator_id, cp.title, cp.caption, cp.visibility, cp.status, cp.requires_payment, cp.unlock_price_credits, cp.published_at, cp.scheduled_for, cp.metadata, cp.created_at, cp.updated_at
       FROM content_post cp
       INNER JOIN creator_profile c ON c.id = cp.creator_id
       INNER JOIN follow_relation fr ON fr.creator_user_id = c.user_id
       WHERE fr.follower_user_id = $1
         AND cp.status = 'published'
         AND ($3::boolean = FALSE OR EXISTS (
           SELECT 1
           FROM subscription s
           WHERE s.subscriber_user_id = $1::uuid
             AND s.creator_id = cp.creator_id
             AND s.status = 'active'
             AND (s.current_period_end IS NULL OR s.current_period_end > now())
         ))
       ORDER BY cp.published_at DESC NULLS LAST, cp.created_at DESC
       LIMIT $2`,
      [req.auth.sub, limit, subscribersOnlyCatalog]
    );
    return res.json({ feed: result.rows.map(sanitizeContent) });
  } catch (error) {
    return res.status(500).json({ error: 'failed to fetch following feed' });
  }
});

v1.get('/feed/trending', authRequired, async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit || 20), 1), 100);

  try {
    const result = await pool.query(
      `SELECT cp.id, cp.creator_id, cp.title, cp.caption, cp.visibility, cp.status, cp.requires_payment, cp.unlock_price_credits, cp.published_at, cp.scheduled_for, cp.metadata, cp.created_at, cp.updated_at
       FROM content_post cp
       LEFT JOIN content_post_media cpm ON cpm.content_post_id = cp.id
       WHERE cp.status = 'published'
         AND (
           ($3::boolean = FALSE AND cp.visibility IN ('public', 'followers'))
           OR ($3::boolean = TRUE)
         )
         AND ($3::boolean = FALSE OR EXISTS (
           SELECT 1
           FROM subscription s
           WHERE s.subscriber_user_id = $1::uuid
             AND s.creator_id = cp.creator_id
             AND s.status = 'active'
             AND (s.current_period_end IS NULL OR s.current_period_end > now())
         ))
       GROUP BY cp.id
       ORDER BY COUNT(cpm.media_asset_id) DESC, cp.published_at DESC NULLS LAST
       LIMIT $2`,
      [req.auth.sub, limit, subscribersOnlyCatalog]
    );
    return res.json({ feed: result.rows.map(sanitizeContent) });
  } catch (error) {
    return res.status(500).json({ error: 'failed to fetch trending feed' });
  }
});

/** Home / discovery: browse creators with subscription price and subscriber counts. */
v1.get('/feed/creators', authRequired, async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit || 20), 1), 100);
  const offset = Math.min(Math.max(Number(req.query.offset || 0), 0), 10000);
  const search = req.query?.search ? String(req.query.search).trim() : null;
  const category = req.query?.category ? String(req.query.category).trim() : null;
  const verificationStatus = req.query?.verification_status ? String(req.query.verification_status).trim() : null;

  const allowedVerificationStatuses = new Set(['pending', 'approved', 'rejected']);
  if (verificationStatus && !allowedVerificationStatuses.has(verificationStatus)) {
    return res.status(400).json({ error: 'invalid verification_status (pending, approved, rejected)' });
  }

  const searchPattern = search ? `%${search}%` : null;

  try {
    const result = await pool.query(
      `SELECT cp.*, ua.username, ua.display_name, ua.avatar_url, ua.bio,
              (SELECT COUNT(*)::int
               FROM subscription s
               WHERE s.creator_id = cp.id
                 AND s.status = 'active'
                 AND (s.current_period_end IS NULL OR s.current_period_end > now())) AS active_subscriber_count,
              EXISTS (
                SELECT 1 FROM follow_relation fr
                WHERE fr.follower_user_id = $1::uuid AND fr.creator_user_id = cp.user_id
              ) AS viewer_is_following,
              EXISTS (
                SELECT 1 FROM subscription sv
                WHERE sv.subscriber_user_id = $1::uuid AND sv.creator_id = cp.id
                  AND sv.status = 'active'
                  AND (sv.current_period_end IS NULL OR sv.current_period_end > now())
              ) AS viewer_is_subscribed
       FROM creator_profile cp
       INNER JOIN user_account ua ON ua.id = cp.user_id
       WHERE ua.status = 'active'
         AND ($4::text IS NULL OR cp.verification_status::text = $4::text)
         AND ($5::text IS NULL OR ua.username ILIKE $5::text OR ua.display_name ILIKE $5::text OR cp.stage_name ILIKE $5::text OR cp.about ILIKE $5::text)
         AND ($6::text IS NULL OR EXISTS (
           SELECT 1
           FROM unnest(cp.category_tags) t
           WHERE lower(t) = lower($6::text)
         ))
       ORDER BY active_subscriber_count DESC, cp.updated_at DESC NULLS LAST, cp.created_at DESC
       LIMIT $2 OFFSET $3`,
      [req.auth.sub, limit, offset, verificationStatus, searchPattern, category]
    );

    return res.json({
      creators: result.rows.map((row) => ({
        creator: {
          ...sanitizeCreator(row),
          username: row.username,
          displayName: row.display_name,
          avatarUrl: rewriteStoredMediaUrlToPublicRead(row.avatar_url),
          bio: row.bio,
          about: mergeCreatorPublicAbout(row)
        },
        stats: {
          activeSubscribers: Number(row.active_subscriber_count || 0),
          subscriptionPriceCredits: Number(row.default_subscription_price_credits || 0)
        },
        viewer: {
          isFollowing: Boolean(row.viewer_is_following),
          isSubscribed: Boolean(row.viewer_is_subscribed)
        }
      }))
    });
  } catch (error) {
    return res.status(500).json({ error: 'failed to fetch creator discovery feed' });
  }
});

v1.post('/payments/deposit', authRequired, async (req, res) => {
  const amountCredits = parsePositiveInteger(req.body?.amountCredits);
  if (!amountCredits) {
    return res.status(400).json({ error: 'amountCredits must be a positive integer' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureWallet(client, req.auth.sub);
    const wallet = await loadWalletForUpdate(client, req.auth.sub);
    if (!wallet) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'wallet not found' });
    }

    const before = Number(wallet.available_credits);
    const after = before + amountCredits;
    await client.query(
      `UPDATE wallet_account
       SET available_credits = $1,
           lifetime_earned_credits = lifetime_earned_credits + $2,
           updated_at = now()
       WHERE id = $3`,
      [after, amountCredits, wallet.id]
    );

    const ledger = await client.query(
      `INSERT INTO credit_ledger (wallet_id, user_id, direction, entry_type, amount_credits, balance_before, balance_after, reference_type)
       VALUES ($1, $2, 'credit', 'deposit', $3, $4, $5, 'deposit')
       RETURNING id, created_at`,
      [wallet.id, req.auth.sub, amountCredits, before, after]
    );

    await client.query('COMMIT');
    return res.status(201).json({
      amountCredits,
      wallet: { before, after },
      ledger: ledger.rows[0]
    });
  } catch (error) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: 'failed to deposit credits' });
  } finally {
    client.release();
  }
});

v1.post('/payments/subscribe', authRequired, async (req, res) => {
  const creatorId = String(req.body?.creatorId || '').trim();
  const amountCredits = parsePositiveInteger(req.body?.amountCredits || 1);
  if (!creatorId || !amountCredits) {
    return res.status(400).json({ error: 'creatorId and positive amountCredits are required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const actor = await getCurrentUserProfile(req.auth.sub, client);
    const creatorResult = await client.query(
      `SELECT id, user_id
       FROM creator_profile
       WHERE id = $1
       LIMIT 1`,
      [creatorId]
    );
    if (creatorResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'creator not found' });
    }
    const creator = creatorResult.rows[0];
    if (creator.user_id === req.auth.sub) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'cannot subscribe to yourself' });
    }

    const transfer = await transferCredits({
      client,
      fromUserId: req.auth.sub,
      toUserId: creator.user_id,
      amountCredits,
      debitEntryType: 'subscription_charge',
      creditEntryType: 'subscription_payout',
      referenceType: 'subscription',
      referenceId: creator.id
    });

    const subscription = await client.query(
      `INSERT INTO subscription (
         subscriber_user_id, creator_id, status, started_at, current_period_start, current_period_end, renewal_enabled
       )
       VALUES ($1, $2, 'active', now(), now(), now() + interval '30 days', TRUE)
       ON CONFLICT (subscriber_user_id, creator_id)
       DO UPDATE SET
         status = 'active',
         current_period_start = now(),
         current_period_end = now() + interval '30 days',
         cancelled_at = NULL,
         renewal_enabled = TRUE,
         updated_at = now()
       RETURNING id, subscriber_user_id, creator_id, status, current_period_start, current_period_end, renewal_enabled, created_at, updated_at`,
      [req.auth.sub, creator.id]
    );

    const creatorNotification = await createNotification({
      userId: creator.user_id,
      type: 'subscription',
      title: 'New subscriber',
      body: `${actor?.display_name || actor?.username || 'Someone'} subscribed to you`,
      deepLink: '/creator',
      payload: {
        subscriberUserId: req.auth.sub,
        creatorId: creator.id,
        amountCredits
      },
      client
    });

    await client.query('COMMIT');
    pushNotification(creatorNotification).catch((error) => {
      // eslint-disable-next-line no-console
      console.error(error.message);
    });
    return res.status(201).json({
      subscription: subscription.rows[0],
      transfer
    });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error && error.code === 'INSUFFICIENT_CREDITS') {
      return res.status(400).json({ error: 'insufficient credits' });
    }
    return res.status(500).json({ error: 'failed to process subscription payment' });
  } finally {
    client.release();
  }
});

v1.post('/payments/tip', authRequired, async (req, res) => {
  const creatorUserId = String(req.body?.creatorUserId || '').trim();
  const amountCredits = parsePositiveInteger(req.body?.amountCredits);
  if (!creatorUserId || !amountCredits) {
    return res.status(400).json({ error: 'creatorUserId and positive amountCredits are required' });
  }
  if (creatorUserId === req.auth.sub) {
    return res.status(400).json({ error: 'cannot tip yourself' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const creator = await client.query(
      `SELECT cp.id, cp.user_id
       FROM creator_profile cp
       WHERE cp.user_id = $1
       LIMIT 1`,
      [creatorUserId]
    );
    if (creator.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'creator not found' });
    }

    const transfer = await transferCredits({
      client,
      fromUserId: req.auth.sub,
      toUserId: creatorUserId,
      amountCredits,
      debitEntryType: 'tip_debit',
      creditEntryType: 'tip_credit',
      referenceType: 'tip',
      referenceId: creator.rows[0].id
    });

    const liveForTip = await client.query(
      `SELECT ls.room_id::text AS room_id
       FROM live_session ls
       INNER JOIN creator_profile cp ON cp.id = ls.creator_id
       WHERE cp.user_id = $1
         AND ls.status = 'live'
         AND ls.room_id IS NOT NULL
       LIMIT 1`,
      [creatorUserId]
    );

    const insertedNotif = await client.query(
      `INSERT INTO notification (user_id, type, title, body, payload)
       VALUES ($1, 'tip', 'New tip received', $2, $3::jsonb)
       RETURNING id, user_id, type, status, title, body, deep_link, payload, created_at, read_at, archived_at`,
      [
        creatorUserId,
        `${amountCredits} credits tipped to you`,
        JSON.stringify({
          fromUserId: req.auth.sub,
          amountCredits
        })
      ]
    );

    await client.query('COMMIT');
    const notif = insertedNotif.rows[0];
    publishNotifyEvent(creatorUserId, 'notification.created', {
      notification: sanitizeNotificationRow(notif)
    }).catch((error) => {
      // eslint-disable-next-line no-console
      console.error(error.message);
    });
    const tipRoomId = liveForTip.rows[0]?.room_id;
    if (tipRoomId) {
      publishChatEvent(tipRoomId, 'tip.received', {
        fromUserId: req.auth.sub,
        amountCredits,
        creatorUserId
      }).catch((error) => {
        // eslint-disable-next-line no-console
        console.error(error.message);
      });
    }
    return res.status(201).json({ transfer });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error && error.code === 'INSUFFICIENT_CREDITS') {
      return res.status(400).json({ error: 'insufficient credits' });
    }
    return res.status(500).json({ error: 'failed to send tip' });
  } finally {
    client.release();
  }
});

v1.get('/payments/history', authRequired, async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 200);

  try {
    const result = await pool.query(
      `SELECT id, direction, entry_type, amount_credits, balance_before, balance_after, counterpart_user_id, reference_type, reference_id, metadata, created_at
       FROM credit_ledger
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [req.auth.sub, limit]
    );
    return res.json({ history: result.rows });
  } catch (error) {
    return res.status(500).json({ error: 'failed to fetch payment history' });
  }
});

v1.get('/wallet/balance', authRequired, async (req, res) => {
  try {
    await ensureWallet(pool, req.auth.sub);
    const result = await pool.query(
      `SELECT id, user_id, available_credits, held_credits, lifetime_earned_credits, lifetime_spent_credits, updated_at
       FROM wallet_account
       WHERE user_id = $1
       LIMIT 1`,
      [req.auth.sub]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'wallet not found' });
    }
    return res.json({ wallet: result.rows[0] });
  } catch (error) {
    return res.status(500).json({ error: 'failed to fetch wallet' });
  }
});

v1.post('/payouts/request', authRequired, async (req, res) => {
  const requestedCredits = parsePositiveInteger(req.body?.amountCredits);
  if (!requestedCredits) {
    return res.status(400).json({ error: 'amountCredits must be a positive integer' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const creatorResult = await client.query(
      `SELECT id
       FROM creator_profile
       WHERE user_id = $1
       LIMIT 1`,
      [req.auth.sub]
    );
    if (creatorResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'creator profile required' });
    }
    const creatorId = creatorResult.rows[0].id;

    await ensureWallet(client, req.auth.sub);
    const wallet = await loadWalletForUpdate(client, req.auth.sub);
    if (!wallet || Number(wallet.available_credits) < requestedCredits) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'insufficient available credits' });
    }

    const availableAfter = Number(wallet.available_credits) - requestedCredits;
    const heldAfter = Number(wallet.held_credits) + requestedCredits;
    await client.query(
      `UPDATE wallet_account
       SET available_credits = $1,
           held_credits = $2,
           updated_at = now()
       WHERE id = $3`,
      [availableAfter, heldAfter, wallet.id]
    );

    await client.query(
      `INSERT INTO credit_ledger (
         wallet_id, user_id, direction, entry_type, amount_credits, balance_before, balance_after, reference_type, metadata
       )
       VALUES ($1, $2, 'debit', 'payout_debit', $3, $4, $5, 'payout', $6::jsonb)`,
      [wallet.id, req.auth.sub, requestedCredits, Number(wallet.available_credits), availableAfter, JSON.stringify({ heldCreditsAfter: heldAfter })]
    );

    const payout = await client.query(
      `INSERT INTO payout_request (
         creator_id, requested_credits, payout_method, payout_destination_masked, status, metadata
       )
       VALUES ($1, $2, $3, $4, 'requested', COALESCE($5::jsonb, '{}'::jsonb))
       RETURNING id, creator_id, requested_credits, payout_method, payout_destination_masked, status, requested_at`,
      [
        creatorId,
        requestedCredits,
        req.body?.payoutMethod ? String(req.body.payoutMethod).trim() : null,
        req.body?.payoutDestinationMasked ? String(req.body.payoutDestinationMasked).trim() : null,
        req.body?.metadata ? JSON.stringify(req.body.metadata) : null
      ]
    );

    await client.query('COMMIT');
    return res.status(201).json({ payoutRequest: payout.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: 'failed to request payout' });
  } finally {
    client.release();
  }
});

v1.get('/payouts/history', authRequired, async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 200);

  try {
    const creatorResult = await pool.query(
      `SELECT id
       FROM creator_profile
       WHERE user_id = $1
       LIMIT 1`,
      [req.auth.sub]
    );
    if (creatorResult.rows.length === 0) {
      return res.status(403).json({ error: 'creator profile required' });
    }

    const result = await pool.query(
      `SELECT id, creator_id, requested_credits, payout_method, payout_destination_masked, status, requested_at, processed_at, rejection_reason, metadata
       FROM payout_request
       WHERE creator_id = $1
       ORDER BY requested_at DESC
       LIMIT $2`,
      [creatorResult.rows[0].id, limit]
    );
    return res.json({ payouts: result.rows });
  } catch (error) {
    return res.status(500).json({ error: 'failed to fetch payout history' });
  }
});

v1.get('/notifications', authRequired, async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 200);
  try {
    const result = await pool.query(
      `SELECT id, type, status, title, body, deep_link, payload, created_at, read_at, archived_at
       FROM notification
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [req.auth.sub, limit]
    );
    return res.json({ notifications: result.rows });
  } catch (error) {
    return res.status(500).json({ error: 'failed to fetch notifications' });
  }
});

v1.get('/notifications/ws-token', authRequired, async (req, res) => {
  const token = jwt.sign({ sub: req.auth.sub, typ: 'notify' }, accessTokenSecret, { expiresIn: '15m' });
  return res.json({
    token,
    wsUrl: `${chatPublicUrl}/ws?token=${encodeURIComponent(token)}`,
    longPollUrl: `${chatPublicUrl}/realtime/notify/events?token=${encodeURIComponent(token)}`
  });
});

v1.post('/notifications/read', authRequired, async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map((id) => String(id).trim()).filter(Boolean) : [];
  const readAll = Boolean(req.body?.readAll);

  if (!readAll && ids.length === 0) {
    return res.status(400).json({ error: 'ids or readAll=true is required' });
  }

  try {
    const result = readAll
      ? await pool.query(
          `UPDATE notification
           SET status = 'read', read_at = now()
           WHERE user_id = $1
             AND status = 'unread'`,
          [req.auth.sub]
        )
      : await pool.query(
          `UPDATE notification
           SET status = 'read', read_at = now()
           WHERE user_id = $1
             AND id = ANY($2::uuid[])
             AND status = 'unread'`,
          [req.auth.sub, ids]
        );
    return res.json({ markedRead: result.rowCount });
  } catch (error) {
    return res.status(500).json({ error: 'failed to mark notifications as read' });
  }
});

v1.get('/admin/users', authRequired, async (req, res) => {
  if (req.auth.role !== 'admin') {
    return res.status(403).json({ error: 'admin access required' });
  }

  const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 200);
  try {
    const result = await pool.query(
      `SELECT id, email, username, display_name, status, created_at
       FROM user_account
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit]
    );
    return res.json({ users: result.rows });
  } catch (error) {
    return res.status(500).json({ error: 'failed to fetch users' });
  }
});

v1.get('/admin/creators', authRequired, async (req, res) => {
  if (req.auth.role !== 'admin') {
    return res.status(403).json({ error: 'admin access required' });
  }

  const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 200);
  try {
    const result = await pool.query(
      `SELECT cp.id, cp.user_id, cp.stage_name, cp.verification_status, cp.default_subscription_price_credits, cp.live_enabled, cp.video_call_enabled, cp.created_at, ua.username, ua.display_name
       FROM creator_profile cp
       INNER JOIN user_account ua ON ua.id = cp.user_id
       ORDER BY cp.created_at DESC
       LIMIT $1`,
      [limit]
    );
    return res.json({ creators: result.rows.map((row) => ({ ...sanitizeCreator(row), username: row.username, displayName: row.display_name })) });
  } catch (error) {
    return res.status(500).json({ error: 'failed to fetch creators' });
  }
});

v1.get('/admin/creator-verifications', authRequired, async (req, res) => {
  if (req.auth.role !== 'admin') {
    return res.status(403).json({ error: 'admin access required' });
  }

  const status = req.query?.status ? String(req.query.status).trim() : null;
  const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 200);
  const offset = Math.min(Math.max(Number(req.query.offset || 0), 0), 100000);

  try {
    const result = await pool.query(
      `SELECT s.id,
              s.creator_id,
              s.status,
              s.submitted_at,
              s.reviewed_at,
              s.reviewed_by,
              s.metadata,
              cp.user_id AS creator_user_id,
              ua.username,
              ua.display_name,
              cp.stage_name
       FROM creator_verification_submission s
       INNER JOIN creator_profile cp ON cp.id = s.creator_id
       INNER JOIN user_account ua ON ua.id = cp.user_id
       WHERE ($1::text IS NULL OR s.status::text = $1::text)
       ORDER BY s.submitted_at DESC
       LIMIT $2
       OFFSET $3`,
      [status, limit, offset]
    );

    return res.json({
      submissions: result.rows.map((row) => ({
        id: row.id,
        creatorId: row.creator_id,
        status: row.status,
        submittedAt: row.submitted_at,
        reviewedAt: row.reviewed_at,
        reviewedBy: row.reviewed_by,
        metadata: row.metadata,
        creator: {
          userId: row.creator_user_id,
          username: row.username,
          displayName: row.display_name,
          stageName: row.stage_name
        }
      }))
    });
  } catch (error) {
    return res.status(500).json({ error: 'failed to fetch creator verifications' });
  }
});

v1.post('/admin/creator-verifications/:submissionId/approve', authRequired, async (req, res) => {
  if (req.auth.role !== 'admin') {
    return res.status(403).json({ error: 'admin access required' });
  }

  const submissionId = req.params.submissionId;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const submission = await client.query(
      `SELECT id, creator_id
       FROM creator_verification_submission
       WHERE id = $1
       LIMIT 1`,
      [submissionId]
    );
    if (submission.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'verification submission not found' });
    }

    await client.query(
      `UPDATE creator_verification_submission
       SET status = 'approved',
           reviewed_at = now(),
           reviewed_by = $2
       WHERE id = $1`,
      [submissionId, req.auth.sub]
    );

    await client.query(
      `UPDATE creator_profile
       SET verification_status = 'approved',
           verified_at = now(),
           verified_by = $2,
           updated_at = now()
       WHERE id = $1`,
      [submission.rows[0].creator_id, req.auth.sub]
    );

    await client.query('COMMIT');
    return res.json({ approved: true, submissionId });
  } catch (error) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: 'failed to approve verification' });
  } finally {
    client.release();
  }
});

v1.post('/admin/creator-verifications/:submissionId/reject', authRequired, async (req, res) => {
  if (req.auth.role !== 'admin') {
    return res.status(403).json({ error: 'admin access required' });
  }

  const submissionId = req.params.submissionId;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const submission = await client.query(
      `SELECT id, creator_id
       FROM creator_verification_submission
       WHERE id = $1
       LIMIT 1`,
      [submissionId]
    );
    if (submission.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'verification submission not found' });
    }

    await client.query(
      `UPDATE creator_verification_submission
       SET status = 'rejected',
           reviewed_at = now(),
           reviewed_by = $2
       WHERE id = $1`,
      [submissionId, req.auth.sub]
    );

    await client.query(
      `UPDATE creator_profile
       SET verification_status = 'rejected',
           verified_at = NULL,
           verified_by = NULL,
           updated_at = now()
       WHERE id = $1`,
      [submission.rows[0].creator_id]
    );

    await client.query('COMMIT');
    return res.json({ rejected: true, submissionId });
  } catch (error) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: 'failed to reject verification' });
  } finally {
    client.release();
  }
});

v1.post('/admin/ban-user', authRequired, async (req, res) => {
  if (req.auth.role !== 'admin') {
    return res.status(403).json({ error: 'admin access required' });
  }

  const userId = String(req.body?.userId || '').trim();
  if (!userId) {
    return res.status(400).json({ error: 'userId is required' });
  }

  try {
    const updated = await pool.query(
      `UPDATE user_account
       SET status = 'banned', updated_at = now()
       WHERE id = $1
       RETURNING id, status`,
      [userId]
    );
    if (updated.rows.length === 0) {
      return res.status(404).json({ error: 'user not found' });
    }
    return res.json({ user: updated.rows[0] });
  } catch (error) {
    return res.status(500).json({ error: 'failed to ban user' });
  }
});

v1.get('/admin/moderation/reports', authRequired, async (req, res) => {
  if (!new Set(['admin', 'moderator']).has(req.auth.role)) {
    return res.status(403).json({ error: 'admin or moderator access required' });
  }

  const status = req.query?.status ? String(req.query.status).trim() : 'open';
  const targetType = req.query?.targetType ? String(req.query.targetType).trim() : 'message';
  const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 200);
  const offset = Math.min(Math.max(Number(req.query.offset || 0), 0), 100000);

  const allowedStatuses = new Set(['open', 'in_review', 'resolved', 'dismissed']);
  if (!allowedStatuses.has(status)) {
    return res.status(400).json({ error: 'invalid status' });
  }

  const allowedTargetTypes = new Set(['user', 'content', 'message', 'live_session', 'video_call_session']);
  if (!allowedTargetTypes.has(targetType)) {
    return res.status(400).json({ error: 'invalid targetType' });
  }

  try {
    const result = await pool.query(
      `SELECT mr.id,
              mr.reporter_user_id,
              ua.username,
              ua.display_name,
              mr.target_type::text AS target_type,
              mr.target_id::text AS target_id,
              mr.reason_code,
              mr.reason_text,
              mr.status::text AS status,
              mr.priority,
              mr.assigned_to::text AS assigned_to,
              mr.created_at,
              mr.resolved_at
       FROM moderation_report mr
       INNER JOIN user_account ua ON ua.id = mr.reporter_user_id
       WHERE mr.status::text = $1::text
         AND mr.target_type::text = $2::text
       ORDER BY mr.priority ASC, mr.created_at DESC
       LIMIT $3 OFFSET $4`,
      [status, targetType, limit, offset]
    );

    return res.json({
      reports: result.rows.map((row) => ({
        id: row.id,
        reporterUserId: row.reporter_user_id,
        reporter: { username: row.username, displayName: row.display_name },
        target: { type: row.target_type, id: row.target_id },
        reasonCode: row.reason_code,
        reasonText: row.reason_text,
        status: row.status,
        priority: Number(row.priority),
        assignedTo: row.assigned_to,
        createdAt: row.created_at,
        resolvedAt: row.resolved_at
      }))
    });
  } catch (error) {
    return res.status(500).json({ error: 'failed to fetch moderation reports' });
  }
});

v1.post('/admin/moderation/reports/:reportId/action', authRequired, async (req, res) => {
  if (!new Set(['admin', 'moderator']).has(req.auth.role)) {
    return res.status(403).json({ error: 'admin or moderator access required' });
  }

  const reportId = String(req.params.reportId || '').trim();
  const actionType = req.body?.actionType ? String(req.body.actionType).trim() : '';
  const reason = req.body?.reason !== undefined ? String(req.body.reason).trim() : null;
  const expiresInSeconds = req.body?.expiresInSeconds !== undefined ? Number(req.body.expiresInSeconds) : null;

  const allowedActions = new Set(['hide_content', 'remove_content']);
  if (!reportId) {
    return res.status(400).json({ error: 'reportId is required' });
  }
  if (!allowedActions.has(actionType)) {
    return res.status(400).json({ error: 'invalid actionType' });
  }
  if (reason && reason.length > 2000) {
    return res.status(400).json({ error: 'reason is too long' });
  }
  if (expiresInSeconds !== null && (!Number.isInteger(expiresInSeconds) || expiresInSeconds <= 0)) {
    return res.status(400).json({ error: 'expiresInSeconds must be a positive integer' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const report = await client.query(
      `SELECT id, target_type::text AS target_type, target_id::text AS target_id
       FROM moderation_report
       WHERE id = $1
       LIMIT 1`,
      [reportId]
    );
    if (report.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'report not found' });
    }

    await client.query(
      `INSERT INTO moderation_action (
         report_id,
         actor_admin_user_id,
         target_type,
         target_id,
         action_type,
         reason,
         expires_at
       )
       VALUES (
         $1::uuid,
         $2::uuid,
         $3::moderation_target_type,
         $4::uuid,
         $5::moderation_action_type,
         $6::text,
         CASE
           WHEN $7::int IS NULL THEN NULL
           ELSE now() + ($7::int * interval '1 second')
         END
       )`,
      [reportId, req.auth.sub, report.rows[0].target_type, report.rows[0].target_id, actionType, reason, expiresInSeconds]
    );

    await client.query(
      `UPDATE moderation_report
       SET status = 'resolved',
           assigned_to = $2::uuid,
           resolved_at = now(),
           updated_at = now()
       WHERE id = $1::uuid`,
      [reportId, req.auth.sub]
    );

    await client.query('COMMIT');
    return res.json({ resolved: true, reportId });
  } catch (error) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: 'failed to apply moderation action' });
  } finally {
    client.release();
  }
});

v1.post('/admin/moderation/reports/:reportId/dismiss', authRequired, async (req, res) => {
  if (!new Set(['admin', 'moderator']).has(req.auth.role)) {
    return res.status(403).json({ error: 'admin or moderator access required' });
  }

  const reportId = String(req.params.reportId || '').trim();
  if (!reportId) {
    return res.status(400).json({ error: 'reportId is required' });
  }

  try {
    const updated = await pool.query(
      `UPDATE moderation_report
       SET status = 'dismissed',
           resolved_at = now(),
           updated_at = now()
       WHERE id = $1::uuid
       RETURNING id`,
      [reportId]
    );
    if (updated.rows.length === 0) {
      return res.status(404).json({ error: 'report not found' });
    }
    return res.json({ dismissed: true, reportId });
  } catch (error) {
    return res.status(500).json({ error: 'failed to dismiss report' });
  }
});

v1.get('/chat/ws-token', authRequired, async (req, res) => {
  const roomId = String(req.query.roomId || '');
  if (!roomId) {
    return res.status(400).json({ error: 'roomId is required' });
  }

  if (!(await isRoomParticipant(roomId, req.auth.sub))) {
    return res.status(403).json({ error: 'not a participant of this room' });
  }

  const token = jwt.sign(
    { sub: req.auth.sub, roomId, typ: 'chat' },
    accessTokenSecret,
    { expiresIn: '15m' }
  );

  return res.json({
    token,
    roomId,
    wsUrl: `${chatPublicUrl}/ws?token=${token}&roomId=${roomId}`,
    longPollUrl: `${chatPublicUrl}/realtime/rooms/${roomId}/events?token=${token}`
  });
});

v1.get('/chat/rooms', authRequired, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT cr.id, cr.room_type, cr.subject, cr.created_at, cr.updated_at
       FROM chat_room cr
       INNER JOIN chat_room_participant crp
         ON crp.room_id = cr.id
       WHERE crp.user_id = $1
         AND crp.left_at IS NULL
         AND cr.is_active = TRUE
       ORDER BY cr.updated_at DESC, cr.created_at DESC
       LIMIT 100`,
      [req.auth.sub]
    );
    return res.json({ rooms: result.rows });
  } catch (error) {
    return res.status(500).json({ error: 'failed to fetch rooms' });
  }
});

v1.get('/chat/rooms/summary', authRequired, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, private, max-age=0, must-revalidate');
  try {
    if (chatHistoryDelegate) {
      try {
        const delegated = await delegateChatHistory(req, 'GET', '/internal/history/rooms/summary');
        if (delegated.status >= 200 && delegated.status < 300) {
          const rooms = Array.isArray(delegated.body?.rooms)
            ? delegated.body.rooms.map((room) => ({
                ...room,
                otherParticipant: room?.otherParticipant
                  ? {
                      ...room.otherParticipant,
                      avatarUrl: rewriteStoredMediaUrlToPublicRead(room.otherParticipant.avatarUrl)
                    }
                  : null
              }))
            : [];
          return res.status(delegated.status).json({ rooms });
        }
        if (delegated.status < 500) {
          return res.status(delegated.status).json(delegated.body);
        }
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('chat go summary delegation failed:', error.message);
      }
    }

    const result = await pool.query(
      `SELECT cr.id,
              cr.room_type,
              cr.subject,
              cr.created_at,
              cr.updated_at,
              other.user_id AS other_participant_user_id,
              ua.username AS other_participant_username,
              ua.display_name AS other_participant_display_name,
              ua.avatar_url AS other_participant_avatar_url,
              lm.id AS last_message_id,
              lm.sender_user_id AS last_message_sender_user_id,
              lm.body AS last_message_body,
              lm.status AS last_message_status,
              lm.sent_at AS last_message_sent_at,
              lm.edited_at AS last_message_edited_at,
              lm.deleted_at AS last_message_deleted_at,
              COALESCE(uc.unread_count, 0)::int AS unread_count
       FROM chat_room cr
       INNER JOIN chat_room_participant me
         ON me.room_id = cr.id
        AND me.user_id = $1
        AND me.left_at IS NULL
       LEFT JOIN LATERAL (
         SELECT p.user_id
         FROM chat_room_participant p
         WHERE p.room_id = cr.id
           AND p.user_id <> $1
           AND p.left_at IS NULL
         ORDER BY p.joined_at ASC
         LIMIT 1
       ) other ON TRUE
       LEFT JOIN user_account ua
         ON ua.id = other.user_id
       LEFT JOIN LATERAL (
         SELECT m.id, m.sender_user_id, m.body, m.status, m.sent_at, m.edited_at, m.deleted_at
         FROM message m
         WHERE m.room_id = cr.id
           AND m.context = 'direct'
         ORDER BY m.sent_at DESC
         LIMIT 1
       ) lm ON TRUE
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS unread_count
         FROM message m2
         LEFT JOIN chat_room_read_state rs
           ON rs.room_id = cr.id
          AND rs.user_id = $1
         WHERE m2.room_id = cr.id
           AND m2.context = 'direct'
           AND m2.sender_user_id <> $1
           AND (
             rs.last_read_at IS NULL
             OR m2.sent_at > rs.last_read_at
           )
       ) uc ON TRUE
       WHERE cr.is_active = TRUE
       ORDER BY COALESCE(lm.sent_at, cr.updated_at, cr.created_at) DESC
       LIMIT 100`,
      [req.auth.sub]
    );

    const rooms = result.rows.map((row) => ({
      id: row.id,
      roomType: row.room_type,
      subject: row.subject,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      otherParticipant: row.other_participant_user_id
        ? {
            userId: row.other_participant_user_id,
            username: row.other_participant_username,
            displayName: row.other_participant_display_name,
            avatarUrl: rewriteStoredMediaUrlToPublicRead(row.other_participant_avatar_url)
          }
        : null,
      lastMessage: row.last_message_id
        ? {
            id: row.last_message_id,
            senderUserId: row.last_message_sender_user_id,
            body: row.last_message_body,
            status: row.last_message_status,
            sentAt: row.last_message_sent_at,
            editedAt: row.last_message_edited_at,
            deletedAt: row.last_message_deleted_at
          }
        : null,
      unreadCount: Number(row.unread_count || 0)
    }));

    return res.json({ rooms });
  } catch (error) {
    return res.status(500).json({ error: 'failed to fetch chat room summary' });
  }
});

v1.post('/chat/rooms', authRequired, async (req, res) => {
  const participantUserId = String(req.body?.participantUserId || '').trim();
  if (!participantUserId) {
    return res.status(400).json({ error: 'participantUserId is required' });
  }
    if (participantUserId === req.auth.sub) {
      return res.status(400).json({ error: 'participantUserId must be different from current user' });
    }

  const [meCreator, otherCreator] = await Promise.all([
    userHasCreatorProfile(req.auth.sub),
    userHasCreatorProfile(participantUserId)
  ]);
  if (!meCreator && !otherCreator) {
    return res.status(400).json({
      error: 'direct chat requires at least one participant to be a content creator'
    });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (otherCreator) {
      const targetCreator = await client.query(
        `SELECT chat_enabled
         FROM creator_profile
         WHERE user_id = $1
         LIMIT 1`,
        [participantUserId]
      );
      if (targetCreator.rows.length > 0 && !targetCreator.rows[0].chat_enabled) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'creator is not available for chat right now' });
      }
    }

    const otherUser = await client.query(
      `SELECT id FROM user_account
       WHERE id = $1
         AND status = 'active'
       LIMIT 1`,
      [participantUserId]
    );
    if (otherUser.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'participant user not found' });
    }

    const usersBlocked = await areUsersBlocked(req.auth.sub, participantUserId, client);
    if (usersBlocked) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'participants cannot chat due to blocking' });
    }

    const existingRoom = await client.query(
      `SELECT cr.id
       FROM chat_room cr
       INNER JOIN chat_room_participant me ON me.room_id = cr.id AND me.user_id = $1 AND me.left_at IS NULL
       INNER JOIN chat_room_participant other ON other.room_id = cr.id AND other.user_id = $2 AND other.left_at IS NULL
       WHERE cr.room_type = 'direct'
         AND cr.is_active = TRUE
       LIMIT 1`,
      [req.auth.sub, participantUserId]
    );

    let roomId;
    if (existingRoom.rows.length > 0) {
      roomId = existingRoom.rows[0].id;
    } else {
      const createdRoom = await client.query(
        `INSERT INTO chat_room (room_type, created_by_user_id, is_active)
         VALUES ('direct', $1, TRUE)
         RETURNING id`,
        [req.auth.sub]
      );
      roomId = createdRoom.rows[0].id;

      await client.query(
        `INSERT INTO chat_room_participant (room_id, user_id, role_in_room)
         VALUES ($1, $2, 'member'), ($1, $3, 'member')`,
        [roomId, req.auth.sub, participantUserId]
      );
    }

    await client.query('COMMIT');
    return res.status(201).json({ roomId });
  } catch (error) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: 'failed to create room' });
  } finally {
    client.release();
  }
});

v1.get('/chat/rooms/:id/messages', authRequired, async (req, res) => {
  const roomId = req.params.id;
  const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 100);
  const before = req.query.before ? new Date(String(req.query.before)) : null;
  const beforeValue = before && !Number.isNaN(before.getTime()) ? before.toISOString() : null;
  res.setHeader('Cache-Control', 'no-store, private, max-age=0, must-revalidate');

  try {
    if (!(await isRoomParticipant(roomId, req.auth.sub))) {
      return res.status(403).json({ error: 'not a participant of this room' });
    }

    const otherUserId = await getOtherDirectRoomParticipant(roomId, req.auth.sub);
    if (!otherUserId) {
      return res.status(403).json({ error: 'direct room participant required' });
    }
    if (await areUsersBlocked(req.auth.sub, otherUserId)) {
      return res.status(403).json({ error: 'messages unavailable due to blocking' });
    }

    if (chatHistoryDelegate) {
      const qs = new URLSearchParams({ limit: String(limit) });
      if (beforeValue) {
        qs.set('before', beforeValue);
      }
      const pathAndQuery = `/internal/history/rooms/${encodeURIComponent(roomId)}/messages?${qs.toString()}`;
      try {
        const delegated = await delegateChatHistory(req, 'GET', pathAndQuery);
        if (delegated.status >= 200 && delegated.status < 500) {
          return res.status(delegated.status).json(delegated.body);
        }
        // eslint-disable-next-line no-console
        console.error('chat go message history returned 5xx:', delegated.status, delegated.body?.error || delegated.body);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('chat go message history delegation failed:', error.message);
      }
    }

    const result = await pool.query(
      `SELECT id, room_id, sender_user_id, body, attachments, status, sent_at, edited_at, deleted_at
       FROM message
       WHERE room_id = $1
         AND context = 'direct'
         AND ($2::timestamptz IS NULL OR sent_at < $2::timestamptz)
         AND NOT EXISTS (
           SELECT 1
           FROM moderation_report mr
           INNER JOIN moderation_action ma ON ma.report_id = mr.id
           WHERE mr.target_type = 'message'
             AND mr.target_id = message.id
             AND ma.action_type IN ('hide_content', 'remove_content')
             AND (ma.expires_at IS NULL OR ma.expires_at > now())
         )
       ORDER BY sent_at DESC
       LIMIT $3`,
      [roomId, beforeValue, limit]
    );

    const messages = result.rows.reverse();
    if (chatHistoryShadow) {
      setImmediate(() => {
        shadowChatHistoryCompare(roomId, req.auth.sub, limit, beforeValue, messages);
      });
    }

    return res.json({ messages });
  } catch (error) {
    return res.status(500).json({ error: 'failed to fetch messages' });
  }
});

v1.post('/chat/rooms/:id/messages', authRequired, async (req, res) => {
  const roomId = req.params.id;
  const messageBody = String(req.body?.body || '').trim();
  if (!messageBody) {
    return res.status(400).json({ error: 'body is required' });
  }
  if (messageBody.length > 4000) {
    return res.status(400).json({ error: 'body is too long' });
  }

  try {
    if (!(await isRoomParticipant(roomId, req.auth.sub))) {
      return res.status(403).json({ error: 'not a participant of this room' });
    }

    const otherUserId = await getOtherDirectRoomParticipant(roomId, req.auth.sub);
    if (!otherUserId) {
      return res.status(403).json({ error: 'direct room participant required' });
    }
    if (await areUsersBlocked(req.auth.sub, otherUserId)) {
      return res.status(403).json({ error: 'cannot send messages due to blocking' });
    }

    const sender = await getCurrentUserProfile(req.auth.sub);
    const recipientCreatorProfile = await getCreatorProfileForUser(otherUserId);

    if (chatHistoryDelegate) {
      try {
        const pathAndQuery = `/internal/history/rooms/${encodeURIComponent(roomId)}/messages`;
        const delegated = await delegateChatHistory(req, 'POST', pathAndQuery, { body: messageBody });
        if (delegated.status >= 200 && delegated.status < 300) {
          const delegatedMessage = delegated.body?.message;
          if (delegatedMessage?.id) {
            const notification = await createNotification({
              userId: otherUserId,
              type: 'message',
              title: `New message from ${sender?.display_name || sender?.username || 'someone'}`,
              body: messageBody,
              deepLink: recipientCreatorProfile ? '/creator' : '/notifications',
              payload: {
                roomId,
                senderUserId: req.auth.sub,
                messageId: delegatedMessage.id
              }
            });
            pushNotification(notification).catch((error) => {
              // eslint-disable-next-line no-console
              console.error(error.message);
            });
          }
          return res.status(delegated.status).json(delegated.body);
        }
        if (delegated.status < 500) {
          return res.status(delegated.status).json(delegated.body);
        }
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('chat go delegation failed:', error.message);
      }
    }

    const inserted = await pool.query(
      `INSERT INTO message (room_id, context, sender_user_id, body, attachments, status)
       VALUES ($1, 'direct', $2, $3, '[]'::jsonb, 'sent')
       RETURNING id, room_id, sender_user_id, body, attachments, status, sent_at, edited_at, deleted_at`,
      [roomId, req.auth.sub, messageBody]
    );

    const message = inserted.rows[0];
    await pool.query(
      `UPDATE chat_room
       SET updated_at = now()
       WHERE id = $1`,
      [roomId]
    );

    publishChatEvent(roomId, 'message.created', { message }).catch((error) => {
      // eslint-disable-next-line no-console
      console.error(error.message);
    });

    const notification = await createNotification({
      userId: otherUserId,
      type: 'message',
      title: `New message from ${sender?.display_name || sender?.username || 'someone'}`,
      body: messageBody,
      deepLink: recipientCreatorProfile ? '/creator' : '/notifications',
      payload: {
        roomId,
        senderUserId: req.auth.sub,
        messageId: message.id
      }
    });
    pushNotification(notification).catch((error) => {
      // eslint-disable-next-line no-console
      console.error(error.message);
    });

    return res.status(201).json({ message });
  } catch (error) {
    return res.status(500).json({ error: 'failed to send message' });
  }
});

v1.patch('/chat/rooms/:id/messages/:messageId', authRequired, async (req, res) => {
  const roomId = req.params.id;
  const messageId = req.params.messageId;
  const body = String(req.body?.body || '').trim();
  if (!body) {
    return res.status(400).json({ error: 'body is required' });
  }
  if (body.length > 4000) {
    return res.status(400).json({ error: 'body is too long' });
  }

  try {
    if (!(await isRoomParticipant(roomId, req.auth.sub))) {
      return res.status(403).json({ error: 'not a participant of this room' });
    }

    const otherUserId = await getOtherDirectRoomParticipant(roomId, req.auth.sub);
    if (!otherUserId) {
      return res.status(403).json({ error: 'direct room participant required' });
    }
    if (await areUsersBlocked(req.auth.sub, otherUserId)) {
      return res.status(403).json({ error: 'cannot edit messages due to blocking' });
    }

    if (chatHistoryDelegate) {
      const pathAndQuery = `/internal/history/rooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(messageId)}`;
      const { status, body } = await delegateChatHistory(req, 'PATCH', pathAndQuery, { body });
      return res.status(status).json(body);
    }

    const updated = await pool.query(
      `UPDATE message
       SET body = $1, edited_at = now(), status = 'edited'
       WHERE id = $2
         AND room_id = $3
         AND context = 'direct'
         AND sender_user_id = $4
         AND status <> 'deleted'
       RETURNING id, room_id, sender_user_id, body, attachments, status, sent_at, edited_at, deleted_at`,
      [body, messageId, roomId, req.auth.sub]
    );

    if (updated.rows.length === 0) {
      return res.status(404).json({ error: 'message not found or not editable' });
    }

    const message = updated.rows[0];
    publishChatEvent(roomId, 'message.edited', { message }).catch((error) => {
      // eslint-disable-next-line no-console
      console.error(error.message);
    });

    return res.json({ message });
  } catch (error) {
    return res.status(500).json({ error: 'failed to edit message' });
  }
});

v1.delete('/chat/rooms/:id/messages/:messageId', authRequired, async (req, res) => {
  const roomId = req.params.id;
  const messageId = req.params.messageId;

  try {
    if (!(await isRoomParticipant(roomId, req.auth.sub))) {
      return res.status(403).json({ error: 'not a participant of this room' });
    }

    const otherUserId = await getOtherDirectRoomParticipant(roomId, req.auth.sub);
    if (!otherUserId) {
      return res.status(403).json({ error: 'direct room participant required' });
    }
    if (await areUsersBlocked(req.auth.sub, otherUserId)) {
      return res.status(403).json({ error: 'cannot delete messages due to blocking' });
    }

    if (chatHistoryDelegate) {
      const pathAndQuery = `/internal/history/rooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(messageId)}`;
      const { status, body } = await delegateChatHistory(req, 'DELETE', pathAndQuery);
      return res.status(status).json(body);
    }

    const deleted = await pool.query(
      `UPDATE message
       SET status = 'deleted', deleted_at = now(), body = NULL, attachments = '[]'::jsonb
       WHERE id = $1
         AND room_id = $2
         AND context = 'direct'
         AND sender_user_id = $3
         AND status <> 'deleted'
       RETURNING id, room_id, sender_user_id, status, sent_at, edited_at, deleted_at`,
      [messageId, roomId, req.auth.sub]
    );

    if (deleted.rows.length === 0) {
      return res.status(404).json({ error: 'message not found or not deletable' });
    }

    const message = deleted.rows[0];
    publishChatEvent(roomId, 'message.deleted', { message }).catch((error) => {
      // eslint-disable-next-line no-console
      console.error(error.message);
    });

    return res.json({ message });
  } catch (error) {
    return res.status(500).json({ error: 'failed to delete message' });
  }
});

// Report chat messages for moderation
v1.post('/chat/rooms/:id/messages/:messageId/report', authRequired, async (req, res) => {
  const roomId = req.params.id;
  const messageId = req.params.messageId;
  const reasonCode = String(req.body?.reasonCode || '').trim();
  const reasonText = req.body?.reasonText !== undefined ? String(req.body.reasonText).trim() : null;
  const priority = req.body?.priority !== undefined ? Number(req.body.priority) : 3;

  if (!reasonCode) {
    return res.status(400).json({ error: 'reasonCode is required' });
  }
  if (!Number.isInteger(priority) || priority < 1 || priority > 5) {
    return res.status(400).json({ error: 'priority must be an integer between 1 and 5' });
  }
  if (reasonText && reasonText.length > 2000) {
    return res.status(400).json({ error: 'reasonText is too long' });
  }

  try {
    if (!(await isRoomParticipant(roomId, req.auth.sub))) {
      return res.status(403).json({ error: 'not a participant of this room' });
    }

    const messageExists = await pool.query(
      `SELECT id
       FROM message
       WHERE id = $1
         AND room_id = $2
         AND context = 'direct'
       LIMIT 1`,
      [messageId, roomId]
    );
    if (messageExists.rows.length === 0) {
      return res.status(404).json({ error: 'message not found' });
    }

    const inserted = await pool.query(
      `INSERT INTO moderation_report (
         reporter_user_id, target_type, target_id, reason_code, reason_text, priority
       )
       VALUES ($1, 'message', $2::uuid, $3, $4, $5)
       RETURNING id, status, priority, created_at, reason_code, reason_text`,
      [req.auth.sub, messageId, reasonCode, reasonText, priority]
    );

    return res.status(201).json({ report: inserted.rows[0] });
  } catch (error) {
    return res.status(500).json({ error: 'failed to create moderation report' });
  }
});

v1.post('/chat/rooms/:id/read', authRequired, async (req, res) => {
  const roomId = req.params.id;
  const lastReadMessageId = req.body?.lastReadMessageId ? String(req.body.lastReadMessageId) : null;

  try {
    if (chatHistoryDelegate) {
      try {
        const pathAndQuery = `/internal/history/rooms/${encodeURIComponent(roomId)}/read`;
        const delegated = await delegateChatHistory(req, 'POST', pathAndQuery, {
          lastReadMessageId
        });
        if (delegated.status >= 200 && delegated.status < 500) {
          return res.status(delegated.status).json(delegated.body);
        }
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('chat go read delegation failed:', error.message);
      }
    }

    if (!(await isRoomParticipant(roomId, req.auth.sub))) {
      return res.status(403).json({ error: 'not a participant of this room' });
    }

    if (lastReadMessageId) {
      const messageExists = await pool.query(
        `SELECT 1
         FROM message
         WHERE id = $1
           AND room_id = $2
         LIMIT 1`,
        [lastReadMessageId, roomId]
      );
      if (messageExists.rows.length === 0) {
        return res.status(400).json({ error: 'lastReadMessageId does not belong to this room' });
      }
    }

    const result = await pool.query(
      `INSERT INTO chat_room_read_state (room_id, user_id, last_read_message_id, last_read_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (room_id, user_id)
       DO UPDATE SET
         last_read_message_id = EXCLUDED.last_read_message_id,
         last_read_at = EXCLUDED.last_read_at,
         updated_at = now()
       RETURNING room_id, user_id, last_read_message_id, last_read_at, updated_at`,
      [roomId, req.auth.sub, lastReadMessageId]
    );

    const readState = result.rows[0];
    publishChatEvent(roomId, 'room.read', {
      roomId,
      userId: req.auth.sub,
      lastReadMessageId: readState.last_read_message_id,
      lastReadAt: readState.last_read_at
    }).catch((error) => {
      // eslint-disable-next-line no-console
      console.error(error.message);
    });

    return res.json({ readState });
  } catch (error) {
    return res.status(500).json({ error: 'failed to update read state' });
  }
});

const createVideoCallRequestHandler = async (req, res) => {
  const creatorId = String(req.body?.creatorId || '').trim();
  const requestedExpiresInSeconds = req.body?.expiresInSeconds !== undefined
    ? Number(req.body.expiresInSeconds)
    : 300;

  if (!creatorId) {
    return res.status(400).json({ error: 'creatorId is required' });
  }
  if (!Number.isInteger(requestedExpiresInSeconds) || requestedExpiresInSeconds < 60 || requestedExpiresInSeconds > 3600) {
    return res.status(400).json({ error: 'expiresInSeconds must be an integer between 60 and 3600' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const actor = await getCurrentUserProfile(req.auth.sub, client);

    const creatorResult = await client.query(
      `SELECT id, user_id, video_call_enabled
       FROM creator_profile
       WHERE id = $1
       LIMIT 1
       FOR UPDATE`,
      [creatorId]
    );
    if (creatorResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'creator not found' });
    }

    const creator = creatorResult.rows[0];
    if (creator.user_id === req.auth.sub) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'cannot create call with yourself' });
    }
    if (!creator.video_call_enabled) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'video calls are not enabled for this creator' });
    }

    const existingOpen = await client.query(
      `SELECT id, status, requested_at, expires_at
       FROM video_call_request vcr
       WHERE requester_user_id = $1
         AND target_creator_id = $2
         AND status IN ('requested', 'accepted', 'active')
         AND (expires_at IS NULL OR expires_at > now())
       ORDER BY requested_at DESC
       LIMIT 1`,
      [req.auth.sub, creator.id]
    );
    if (existingOpen.rows.length > 0) {
      await client.query('COMMIT');
      return res.status(200).json({ request: existingOpen.rows[0], alreadyOpen: true });
    }

    const created = await client.query(
      `INSERT INTO video_call_request (
         requester_user_id, target_creator_id, status, requested_at, expires_at, metadata
       )
       VALUES ($1, $2, 'requested', now(), now() + ($3 * interval '1 second'), COALESCE($4::jsonb, '{}'::jsonb))
       RETURNING id, requester_user_id, target_creator_id, status, requested_at, responded_at, expires_at, decline_reason, metadata`,
      [
        req.auth.sub,
        creator.id,
        requestedExpiresInSeconds,
        req.body?.metadata ? JSON.stringify(req.body.metadata) : null
      ]
    );

    const creatorNotification = await createNotification({
      userId: creator.user_id,
      type: 'video_call_request',
      title: 'New call request',
      body: `${actor?.display_name || actor?.username || 'Someone'} requested a 1:1 call`,
      deepLink: '/creator',
      payload: {
        requestId: created.rows[0].id,
        requesterUserId: req.auth.sub,
        creatorId: creator.id
      },
      client
    });

    await client.query('COMMIT');
    pushNotification(creatorNotification).catch((error) => {
      // eslint-disable-next-line no-console
      console.error(error.message);
    });
    return res.status(201).json({ request: created.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: 'failed to create call request' });
  } finally {
    client.release();
  }
};

v1.post('/calls/create', authRequired, createVideoCallRequestHandler);
v1.post('/calls/request', authRequired, createVideoCallRequestHandler);

v1.get('/calls/requests/incoming', authRequired, async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit || 20), 1), 100);

  try {
    const creator = await pool.query(
      `SELECT id
       FROM creator_profile
       WHERE user_id = $1
       LIMIT 1`,
      [req.auth.sub]
    );
    if (creator.rows.length === 0) {
      return res.status(403).json({ error: 'creator profile required' });
    }

    const result = await pool.query(
      `SELECT vcr.id,
              vcr.requester_user_id,
              vcr.target_creator_id,
              vcr.status,
              vcr.requested_at,
              vcr.responded_at,
              vcr.expires_at,
              vcr.decline_reason,
              vcr.metadata,
              vcs.id AS session_id,
              vcs.status AS session_status
       FROM video_call_request vcr
       LEFT JOIN LATERAL (
         SELECT id, status
         FROM video_call_session
         WHERE request_id = vcr.id
         ORDER BY created_at DESC
         LIMIT 1
       ) vcs ON TRUE
       WHERE target_creator_id = $1
       ORDER BY requested_at DESC
       LIMIT $2`,
      [creator.rows[0].id, limit]
    );

    return res.json({ requests: result.rows });
  } catch (error) {
    return res.status(500).json({ error: 'failed to fetch incoming call requests' });
  }
});

v1.get('/calls/requests/outgoing', authRequired, async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit || 20), 1), 100);

  try {
    const result = await pool.query(
      `SELECT vcr.id,
              vcr.requester_user_id,
              vcr.target_creator_id,
              vcr.status,
              vcr.requested_at,
              vcr.responded_at,
              vcr.expires_at,
              vcr.decline_reason,
              vcr.metadata,
              vcs.id AS session_id,
              vcs.status AS session_status
       FROM video_call_request vcr
       LEFT JOIN LATERAL (
         SELECT id, status
         FROM video_call_session
         WHERE request_id = vcr.id
         ORDER BY created_at DESC
         LIMIT 1
       ) vcs ON TRUE
       WHERE requester_user_id = $1
       ORDER BY requested_at DESC
       LIMIT $2`,
      [req.auth.sub, limit]
    );

    return res.json({ requests: result.rows });
  } catch (error) {
    return res.status(500).json({ error: 'failed to fetch outgoing call requests' });
  }
});

v1.post('/calls/:requestId/accept', authRequired, async (req, res) => {
  const requestId = req.params.requestId;
  const creditsPerBlock = req.body?.creditsPerBlock !== undefined ? Number(req.body.creditsPerBlock) : 1;
  const blockDurationSeconds = req.body?.blockDurationSeconds !== undefined ? Number(req.body.blockDurationSeconds) : 120;

  if (!Number.isInteger(creditsPerBlock) || creditsPerBlock <= 0) {
    return res.status(400).json({ error: 'creditsPerBlock must be a positive integer' });
  }
  if (!Number.isInteger(blockDurationSeconds) || blockDurationSeconds <= 0) {
    return res.status(400).json({ error: 'blockDurationSeconds must be a positive integer' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const actor = await getCurrentUserProfile(req.auth.sub, client);

    const requestResult = await client.query(
      `SELECT vcr.id,
              vcr.requester_user_id,
              vcr.target_creator_id,
              vcr.status,
              vcr.expires_at,
              cp.user_id AS creator_user_id
       FROM video_call_request vcr
       INNER JOIN creator_profile cp
         ON cp.id = vcr.target_creator_id
       WHERE vcr.id = $1
       LIMIT 1
       FOR UPDATE`,
      [requestId]
    );
    if (requestResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'call request not found' });
    }

    const request = requestResult.rows[0];
    if (request.creator_user_id !== req.auth.sub) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'only target creator can accept this request' });
    }
    if (request.status !== 'requested') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'call request is not in requested state' });
    }
    if (request.expires_at && new Date(request.expires_at).getTime() <= Date.now()) {
      await client.query(
        `UPDATE video_call_request
         SET status = 'expired',
             responded_at = now()
         WHERE id = $1`,
        [request.id]
      );
      await client.query('COMMIT');
      return res.status(409).json({ error: 'call request has expired' });
    }

    const room = await client.query(
      `INSERT INTO chat_room (room_type, created_by_user_id, subject, external_room_key, is_active)
       VALUES ('video_call', $1, $2, $3, TRUE)
       RETURNING id`,
      [req.auth.sub, '1:1 video call', `video-call:${crypto.randomUUID()}`]
    );

    await client.query(
      `INSERT INTO chat_room_participant (room_id, user_id, role_in_room, joined_at)
       VALUES ($1, $2, 'member', now()), ($1, $3, 'member', now())
       ON CONFLICT (room_id, user_id)
       DO UPDATE SET
         role_in_room = EXCLUDED.role_in_room,
         joined_at = EXCLUDED.joined_at,
         left_at = NULL`,
      [room.rows[0].id, request.requester_user_id, request.creator_user_id]
    );

    const session = await client.query(
      `INSERT INTO video_call_session (
         request_id, client_user_id, creator_id, room_id, livekit_room_name, status, expires_at,
         credits_per_block, block_duration_seconds, metadata
       )
       VALUES (
         $1, $2, $3, $4, $5, 'accepted',
         now() + interval '15 minutes',
         $6, $7, COALESCE($8::jsonb, '{}'::jsonb)
       )
       RETURNING id`,
      [
        request.id,
        request.requester_user_id,
        request.target_creator_id,
        room.rows[0].id,
        `call-${request.id}`,
        creditsPerBlock,
        blockDurationSeconds,
        req.body?.metadata ? JSON.stringify(req.body.metadata) : null
      ]
    );

    await client.query(
      `UPDATE video_call_request
       SET status = 'accepted',
           responded_at = now()
       WHERE id = $1`,
      [request.id]
    );

    await client.query(
      `INSERT INTO video_call_event (video_call_session_id, event_type, actor_user_id, event_payload)
       VALUES ($1, 'call.accepted', $2, $3::jsonb)`,
      [
        session.rows[0].id,
        req.auth.sub,
        JSON.stringify({
          requestId: request.id
        })
      ]
    );

    const requesterNotification = await createNotification({
      userId: request.requester_user_id,
      type: 'video_call',
      title: 'Call request accepted',
      body: `${actor?.display_name || actor?.username || 'Creator'} accepted your call request`,
      deepLink: '/notifications',
      payload: {
        requestId: request.id,
        callId: session.rows[0].id
      },
      client
    });

    await client.query('COMMIT');
    pushNotification(requesterNotification).catch((error) => {
      // eslint-disable-next-line no-console
      console.error(error.message);
    });

    const payload = await getVideoCallSessionById(session.rows[0].id);
    if (payload?.call?.roomId) {
      publishChatEvent(payload.call.roomId, 'call.accepted', {
        callId: payload.call.id,
        requestId: request.id
      }).catch((error) => {
        // eslint-disable-next-line no-console
        console.error(error.message);
      });
    }

    return res.status(201).json({ call: payload?.call || null });
  } catch (error) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: 'failed to accept call request' });
  } finally {
    client.release();
  }
});

v1.post('/calls/:requestId/decline', authRequired, async (req, res) => {
  const requestId = req.params.requestId;
  const declineReason = req.body?.reason ? String(req.body.reason).trim() : null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const actor = await getCurrentUserProfile(req.auth.sub, client);

    const requestResult = await client.query(
      `SELECT vcr.id,
              vcr.status,
              cp.user_id AS creator_user_id
       FROM video_call_request vcr
       INNER JOIN creator_profile cp
         ON cp.id = vcr.target_creator_id
       WHERE vcr.id = $1
       LIMIT 1
       FOR UPDATE`,
      [requestId]
    );
    if (requestResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'call request not found' });
    }
    const request = requestResult.rows[0];
    if (request.creator_user_id !== req.auth.sub) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'only target creator can decline this request' });
    }
    if (request.status !== 'requested') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'call request is not in requested state' });
    }

    const declined = await client.query(
      `UPDATE video_call_request
       SET status = 'declined',
           responded_at = now(),
           decline_reason = $2
       WHERE id = $1
       RETURNING id, requester_user_id, target_creator_id, status, requested_at, responded_at, expires_at, decline_reason, metadata`,
      [requestId, declineReason]
    );

    const requesterNotification = await createNotification({
      userId: declined.rows[0].requester_user_id,
      type: 'video_call',
      title: 'Call request declined',
      body: `${actor?.display_name || actor?.username || 'Creator'} declined your call request`,
      deepLink: '/notifications',
      payload: {
        requestId,
        declineReason
      },
      client
    });

    await client.query('COMMIT');
    pushNotification(requesterNotification).catch((error) => {
      // eslint-disable-next-line no-console
      console.error(error.message);
    });
    return res.json({ request: declined.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: 'failed to decline call request' });
  } finally {
    client.release();
  }
});

v1.get('/calls/:id', authRequired, async (req, res) => {
  try {
    const payload = await getVideoCallSessionById(req.params.id);
    if (!payload) {
      return res.status(404).json({ error: 'call not found' });
    }

    if (payload.raw.client_user_id !== req.auth.sub && payload.raw.creator_user_id !== req.auth.sub) {
      return res.status(403).json({ error: 'not a participant of this call' });
    }

    return res.json({ call: payload.call });
  } catch (error) {
    return res.status(500).json({ error: 'failed to fetch call' });
  }
});

v1.post('/calls/:id/token', authRequired, async (req, res) => {
  if (!isLiveKitConfigured()) {
    return res.status(503).json({ error: 'LiveKit is not configured' });
  }

  try {
    const payload = await getVideoCallSessionById(req.params.id);
    if (!payload) {
      return res.status(404).json({ error: 'call not found' });
    }

    const isClient = payload.raw.client_user_id === req.auth.sub;
    const isCreator = payload.raw.creator_user_id === req.auth.sub;
    if (!isClient && !isCreator) {
      return res.status(403).json({ error: 'not a participant of this call' });
    }
    if (!new Set(['accepted', 'active']).has(payload.raw.status)) {
      return res.status(409).json({ error: 'call is not joinable' });
    }

    const currentUser = await getCurrentUserProfile(req.auth.sub);
    const livekit = issueVideoCallLiveKitCredentials({
      call: payload.call,
      userId: req.auth.sub,
      role: isCreator ? 'creator' : 'client',
      displayName: currentUser?.display_name
    });

    return res.json({ call: payload.call, livekit });
  } catch (error) {
    return res.status(500).json({ error: 'failed to issue call token' });
  }
});

v1.post('/calls/:id/join', authRequired, async (req, res) => {
  const client = await pool.connect();
  let committed = false;
  try {
    await client.query('BEGIN');
    const actor = await getCurrentUserProfile(req.auth.sub, client);

    const sessionResult = await client.query(
      `SELECT vcs.id,
              vcs.client_user_id,
              vcs.creator_id,
              vcs.room_id,
              vcs.status,
              vcs.started_at,
              vcs.ended_at,
              vcs.expires_at,
              vcs.credits_per_block,
              vcs.block_duration_seconds,
              vcs.total_billed_credits,
              cp.user_id AS creator_user_id
       FROM video_call_session vcs
       INNER JOIN creator_profile cp
         ON cp.id = vcs.creator_id
       WHERE vcs.id = $1
       LIMIT 1
       FOR UPDATE`,
      [req.params.id]
    );
    if (sessionResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'call not found' });
    }
    const session = sessionResult.rows[0];

    const isClient = session.client_user_id === req.auth.sub;
    const isCreator = session.creator_user_id === req.auth.sub;
    if (!isClient && !isCreator) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'not a participant of this call' });
    }
    if (!new Set(['accepted', 'active']).has(session.status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'call is not joinable' });
    }

    const now = Date.now();
    const expiresAtMs = session.expires_at ? new Date(session.expires_at).getTime() : 0;
    const isExpired = Boolean(expiresAtMs && expiresAtMs <= now);

    let transfer = null;
    const shouldCharge = isClient && (session.status === 'accepted' || isExpired);
    if (shouldCharge) {
      transfer = await transferCredits({
        client,
        fromUserId: req.auth.sub,
        toUserId: session.creator_user_id,
        amountCredits: Number(session.credits_per_block),
        debitEntryType: 'video_call_debit',
        creditEntryType: 'video_call_credit',
        referenceType: session.status === 'accepted' ? 'video_call_join' : 'video_call_extend',
        referenceId: session.id
      });

      await client.query(
        `UPDATE video_call_session
         SET status = 'active',
             started_at = COALESCE(started_at, now()),
             expires_at = GREATEST(COALESCE(expires_at, now()), now()) + (block_duration_seconds * interval '1 second'),
             total_billed_credits = total_billed_credits + credits_per_block,
             updated_at = now()
         WHERE id = $1`,
        [session.id]
      );
    }

    await client.query(
      `INSERT INTO video_call_event (video_call_session_id, event_type, actor_user_id, event_payload)
       VALUES ($1, 'call.joined', $2, $3::jsonb)`,
      [
        session.id,
        req.auth.sub,
        JSON.stringify({
          chargedCredits: transfer ? transfer.amountCredits : 0,
          participantRole: isCreator ? 'creator' : 'client'
        })
      ]
    );

    const notificationRecipientUserId = isCreator ? session.client_user_id : session.creator_user_id;
    const joinNotification = await createNotification({
      userId: notificationRecipientUserId,
      type: 'video_call',
      title: 'Call participant joined',
      body: `${actor?.display_name || actor?.username || 'Participant'} joined the call`,
      deepLink: isCreator ? '/notifications' : '/creator',
      payload: {
        callId: session.id,
        participantUserId: req.auth.sub,
        participantRole: isCreator ? 'creator' : 'client'
      },
      client
    });

    await client.query('COMMIT');
    committed = true;
    pushNotification(joinNotification).catch((error) => {
      // eslint-disable-next-line no-console
      console.error(error.message);
    });

    const payload = await getVideoCallSessionById(session.id);
    const currentUser = await getCurrentUserProfile(req.auth.sub);
    const livekit = isLiveKitConfigured() && payload
      ? issueVideoCallLiveKitCredentials({
          call: payload.call,
          userId: req.auth.sub,
          role: isCreator ? 'creator' : 'client',
          displayName: currentUser?.display_name
        })
      : null;

    if (payload?.call?.roomId) {
      publishChatEvent(payload.call.roomId, 'call.joined', {
        callId: payload.call.id,
        userId: req.auth.sub,
        participantRole: isCreator ? 'creator' : 'client',
        chargedCredits: transfer ? transfer.amountCredits : 0
      }).catch((error) => {
        // eslint-disable-next-line no-console
        console.error(error.message);
      });
    }

    return res.json({
      call: payload?.call || null,
      chargedCredits: transfer ? transfer.amountCredits : 0,
      transfer,
      livekit
    });
  } catch (error) {
    if (!committed) {
      await client.query('ROLLBACK');
    }
    if (error?.code === 'INSUFFICIENT_CREDITS') {
      return res.status(402).json({ error: 'insufficient credits to join call' });
    }
    return res.status(500).json({ error: 'failed to join call' });
  } finally {
    client.release();
  }
});

v1.post('/calls/:id/extend', authRequired, async (req, res) => {
  const client = await pool.connect();
  let committed = false;
  try {
    await client.query('BEGIN');

    const sessionResult = await client.query(
      `SELECT vcs.id,
              vcs.client_user_id,
              vcs.room_id,
              vcs.status,
              vcs.credits_per_block,
              cp.user_id AS creator_user_id
       FROM video_call_session vcs
       INNER JOIN creator_profile cp
         ON cp.id = vcs.creator_id
       WHERE vcs.id = $1
       LIMIT 1
       FOR UPDATE`,
      [req.params.id]
    );
    if (sessionResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'call not found' });
    }
    const session = sessionResult.rows[0];
    if (session.client_user_id !== req.auth.sub) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'only call client can extend this call' });
    }
    if (session.status !== 'active') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'call is not active' });
    }

    const transfer = await transferCredits({
      client,
      fromUserId: req.auth.sub,
      toUserId: session.creator_user_id,
      amountCredits: Number(session.credits_per_block),
      debitEntryType: 'video_call_debit',
      creditEntryType: 'video_call_credit',
      referenceType: 'video_call_extend',
      referenceId: session.id
    });

    await client.query(
      `UPDATE video_call_session
       SET expires_at = GREATEST(COALESCE(expires_at, now()), now()) + (block_duration_seconds * interval '1 second'),
           total_billed_credits = total_billed_credits + credits_per_block,
           updated_at = now()
       WHERE id = $1`,
      [session.id]
    );

    await client.query(
      `INSERT INTO video_call_event (video_call_session_id, event_type, actor_user_id, event_payload)
       VALUES ($1, 'call.extended', $2, $3::jsonb)`,
      [
        session.id,
        req.auth.sub,
        JSON.stringify({
          chargedCredits: transfer.amountCredits
        })
      ]
    );

    await client.query('COMMIT');
    committed = true;

    const payload = await getVideoCallSessionById(session.id);
    if (payload?.call?.roomId) {
      publishChatEvent(payload.call.roomId, 'call.extended', {
        callId: payload.call.id,
        userId: req.auth.sub,
        chargedCredits: transfer.amountCredits
      }).catch((error) => {
        // eslint-disable-next-line no-console
        console.error(error.message);
      });
    }

    return res.json({ call: payload?.call || null, transfer });
  } catch (error) {
    if (!committed) {
      await client.query('ROLLBACK');
    }
    if (error?.code === 'INSUFFICIENT_CREDITS') {
      return res.status(402).json({ error: 'insufficient credits to extend call' });
    }
    return res.status(500).json({ error: 'failed to extend call' });
  } finally {
    client.release();
  }
});

v1.post('/calls/:id/end', authRequired, async (req, res) => {
  const client = await pool.connect();
  let committed = false;
  try {
    await client.query('BEGIN');
    const actor = await getCurrentUserProfile(req.auth.sub, client);

    const sessionResult = await client.query(
      `SELECT vcs.id,
              vcs.client_user_id,
              vcs.room_id,
              vcs.status,
              cp.user_id AS creator_user_id
       FROM video_call_session vcs
       INNER JOIN creator_profile cp
         ON cp.id = vcs.creator_id
       WHERE vcs.id = $1
       LIMIT 1
       FOR UPDATE`,
      [req.params.id]
    );
    if (sessionResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'call not found' });
    }
    const session = sessionResult.rows[0];
    if (session.client_user_id !== req.auth.sub && session.creator_user_id !== req.auth.sub) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'not a participant of this call' });
    }
    if (session.status === 'ended') {
      await client.query('COMMIT');
      const payload = await getVideoCallSessionById(session.id);
      return res.json({ call: payload?.call || null, alreadyEnded: true });
    }

    await client.query(
      `UPDATE video_call_session
       SET status = 'ended',
           ended_at = COALESCE(ended_at, now()),
           updated_at = now()
       WHERE id = $1`,
      [session.id]
    );

    if (session.room_id) {
      await client.query(
        `UPDATE chat_room
         SET is_active = FALSE,
             updated_at = now()
         WHERE id = $1`,
        [session.room_id]
      );
    }

    await client.query(
      `INSERT INTO video_call_event (video_call_session_id, event_type, actor_user_id, event_payload)
       VALUES ($1, 'call.ended', $2, $3::jsonb)`,
      [
        session.id,
        req.auth.sub,
        JSON.stringify({
          endedByUserId: req.auth.sub
        })
      ]
    );

    const otherParticipantUserId = session.client_user_id === req.auth.sub
      ? session.creator_user_id
      : session.client_user_id;
    const endNotification = await createNotification({
      userId: otherParticipantUserId,
      type: 'video_call',
      title: 'Call ended',
      body: `${actor?.display_name || actor?.username || 'Participant'} ended the call`,
      deepLink: otherParticipantUserId === session.creator_user_id ? '/creator' : '/notifications',
      payload: {
        callId: session.id,
        endedByUserId: req.auth.sub
      },
      client
    });

    await client.query('COMMIT');
    committed = true;
    pushNotification(endNotification).catch((error) => {
      // eslint-disable-next-line no-console
      console.error(error.message);
    });

    const payload = await getVideoCallSessionById(session.id);
    if (payload?.call?.roomId) {
      publishChatEvent(payload.call.roomId, 'call.ended', {
        callId: payload.call.id,
        endedByUserId: req.auth.sub
      }).catch((error) => {
        // eslint-disable-next-line no-console
        console.error(error.message);
      });
    }

    return res.json({ call: payload?.call || null });
  } catch (error) {
    if (!committed) {
      await client.query('ROLLBACK');
    }
    return res.status(500).json({ error: 'failed to end call' });
  } finally {
    client.release();
  }
});

v1.post('/streams/start', authRequired, async (req, res) => {
  const title = req.body?.title ? String(req.body.title).trim() : null;
  const description = req.body?.description ? String(req.body.description).trim() : null;
  const streamThumbnailUrl = req.body?.streamThumbnailUrl ? String(req.body.streamThumbnailUrl).trim() : null;
  const scheduledStartAt = req.body?.scheduledStartAt ? new Date(String(req.body.scheduledStartAt)) : null;
  const scheduledStartAtValue = scheduledStartAt && !Number.isNaN(scheduledStartAt.getTime()) ? scheduledStartAt.toISOString() : null;
  const baseJoinPriceCredits = req.body?.baseJoinPriceCredits !== undefined ? Number(req.body.baseJoinPriceCredits) : 1;
  const extendPriceCredits = req.body?.extendPriceCredits !== undefined ? Number(req.body.extendPriceCredits) : 1;
  const extendDurationSeconds = req.body?.extendDurationSeconds !== undefined ? Number(req.body.extendDurationSeconds) : 120;
  const maxConcurrentViewers = req.body?.maxConcurrentViewers !== undefined ? Number(req.body.maxConcurrentViewers) : null;

  if (!Number.isInteger(baseJoinPriceCredits) || baseJoinPriceCredits < 0) {
    return res.status(400).json({ error: 'baseJoinPriceCredits must be a non-negative integer' });
  }
  if (!Number.isInteger(extendPriceCredits) || extendPriceCredits < 0) {
    return res.status(400).json({ error: 'extendPriceCredits must be a non-negative integer' });
  }
  if (!Number.isInteger(extendDurationSeconds) || extendDurationSeconds <= 0) {
    return res.status(400).json({ error: 'extendDurationSeconds must be a positive integer' });
  }
  if (maxConcurrentViewers !== null && (!Number.isInteger(maxConcurrentViewers) || maxConcurrentViewers <= 0)) {
    return res.status(400).json({ error: 'maxConcurrentViewers must be a positive integer when provided' });
  }
  if (req.body?.scheduledStartAt && !scheduledStartAtValue) {
    return res.status(400).json({ error: 'scheduledStartAt must be a valid ISO date-time' });
  }

  const client = await pool.connect();
  let committed = false;
  try {
    await client.query('BEGIN');

    const creatorResult = await client.query(
      `SELECT id, user_id, live_enabled
       FROM creator_profile
       WHERE user_id = $1
       LIMIT 1
       FOR UPDATE`,
      [req.auth.sub]
    );
    if (creatorResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'creator profile required' });
    }

    const creator = creatorResult.rows[0];
    if (!creator.live_enabled) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'live streaming is not enabled for this creator' });
    }

    const existingLive = await client.query(
      `SELECT id
       FROM live_session
       WHERE creator_id = $1
         AND status = 'live'
       ORDER BY started_at DESC NULLS LAST, created_at DESC
       LIMIT 1`,
      [creator.id]
    );
    if (existingLive.rows.length > 0) {
      const existingSessionId = existingLive.rows[0].id;
      if (!(await hasLiveCreatorPresence(existingSessionId))) {
        await endLiveSessionById(existingSessionId, {
          client,
          reason: 'creator_offline',
          viewerUserId: req.auth.sub
        });
      } else {
        await client.query('COMMIT');
        committed = true;
        await touchLiveCreatorPresence(existingSessionId, req.auth.sub);
        const payload = await getLiveSessionById(existingSessionId, req.auth.sub);
        const currentUser = await getCurrentUserProfile(req.auth.sub);
        const livekit = isLiveKitConfigured()
          ? issueLiveKitSessionCredentials({
              stream: payload.stream,
              userId: req.auth.sub,
              role: 'host',
              displayName: currentUser?.display_name
            })
          : null;
        return res.json({ stream: payload.stream, viewerAccess: payload.viewerAccess, alreadyLive: true, livekit });
      }
    }

    const room = await client.query(
      `INSERT INTO chat_room (room_type, created_by_user_id, subject, external_room_key, is_active)
       VALUES ('live_session', $1, $2, $3, TRUE)
       RETURNING id`,
      [req.auth.sub, title, `live:${crypto.randomUUID()}`]
    );

    const created = await client.query(
      `INSERT INTO live_session (
         creator_id,
         room_id,
         livekit_room_name,
         title,
         description,
         stream_thumbnail_url,
         status,
         scheduled_start_at,
         started_at,
         base_join_price_credits,
         extend_price_credits,
         extend_duration_seconds,
         max_concurrent_viewers,
         metadata
       )
       VALUES (
         $1,
         $2,
         $3,
         $4,
         $5,
         $6,
         'live',
         $7,
         now(),
         $8,
         $9,
         $10,
         $11,
         COALESCE($12::jsonb, '{}'::jsonb)
       )
       RETURNING id`,
      [
        creator.id,
        room.rows[0].id,
        `live-${req.auth.sub}-${Date.now()}`,
        title,
        description,
        streamThumbnailUrl,
        scheduledStartAtValue,
        baseJoinPriceCredits,
        extendPriceCredits,
        extendDurationSeconds,
        maxConcurrentViewers,
        req.body?.metadata ? JSON.stringify(req.body.metadata) : null
      ]
    );

    await client.query('COMMIT');
    committed = true;
    await touchLiveCreatorPresence(created.rows[0].id, req.auth.sub);
    const payload = await getLiveSessionById(created.rows[0].id, req.auth.sub);
    const currentUser = await getCurrentUserProfile(req.auth.sub);
    const livekit = isLiveKitConfigured()
      ? issueLiveKitSessionCredentials({
          stream: payload.stream,
          userId: req.auth.sub,
          role: 'host',
          displayName: currentUser?.display_name
        })
      : null;
    return res.status(201).json({ stream: payload.stream, viewerAccess: payload.viewerAccess, livekit });
  } catch (error) {
    if (!committed) {
      await client.query('ROLLBACK');
    }
    return res.status(500).json({ error: 'failed to start live session' });
  } finally {
    client.release();
  }
});

v1.get('/streams/live', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ls.*,
              cp.user_id AS creator_user_id,
              cp.stage_name,
              ua.username,
              ua.display_name,
              ua.avatar_url,
              COALESCE(viewers.active_viewer_count, 0)::int AS active_viewer_count
       FROM live_session ls
       INNER JOIN creator_profile cp
         ON cp.id = ls.creator_id
       INNER JOIN user_account ua
         ON ua.id = cp.user_id
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS active_viewer_count
         FROM live_session_viewer
         WHERE live_session_id = ls.id
           AND is_active = TRUE
       ) viewers ON TRUE
       WHERE ls.status = 'live'
       ORDER BY ls.started_at DESC NULLS LAST, ls.created_at DESC
       LIMIT 100`
    );

    const presenceBySessionId = await getLiveCreatorPresenceMap(result.rows.map((row) => row.id));
    const activeRows = [];
    for (const row of result.rows) {
      if (presenceBySessionId.get(row.id)) {
        activeRows.push(row);
        continue;
      }
      await endLiveSessionById(row.id, { reason: 'creator_offline' });
    }

    return res.json({
      streams: activeRows.map((row) => sanitizeLiveSession(row))
    });
  } catch (error) {
    return res.status(500).json({ error: 'failed to fetch live sessions' });
  }
});

v1.get('/streams/:id', async (req, res) => {
  try {
    const payload = await getLiveSessionById(req.params.id);
    if (!payload) {
      return res.status(404).json({ error: 'live session not found' });
    }
    if (payload.stream.status === 'live' && !(await hasLiveCreatorPresence(req.params.id))) {
      const ended = await endLiveSessionById(req.params.id, { reason: 'creator_offline' });
      return res.json({ stream: ended?.stream || null });
    }
    let stream = payload.stream;
    if (liveAggregateDelegate) {
      const agg = await fetchLiveAggregateFromGo(req.params.id);
      if (agg) {
        stream = {
          ...payload.stream,
          stats: {
            ...payload.stream.stats,
            wsViewerConnections: Number(agg.wsViewerConnections ?? 0),
            aggregateSource: agg.source || 'go_aggregate'
          }
        };
      }
    }
    return res.json({ stream });
  } catch (error) {
    return res.status(500).json({ error: 'failed to fetch live session' });
  }
});

v1.post('/streams/:id/token', authRequired, async (req, res) => {
  if (!isLiveKitConfigured()) {
    return res.status(503).json({ error: 'LiveKit is not configured' });
  }

  try {
    const payload = await getLiveSessionById(req.params.id, req.auth.sub);
    if (!payload) {
      return res.status(404).json({ error: 'live session not found' });
    }
    if (payload.stream.status === 'live' && !(await hasLiveCreatorPresence(req.params.id))) {
      await endLiveSessionById(req.params.id, {
        reason: 'creator_offline',
        viewerUserId: req.auth.sub
      });
      return res.status(409).json({ error: 'live session is not active' });
    }
    if (payload.stream.status !== 'live') {
      return res.status(409).json({ error: 'live session is not active' });
    }

    const role = payload.viewerAccess?.isCreator ? 'host' : 'viewer';
    if (!payload.viewerAccess?.isCreator && !payload.viewerAccess?.isActive) {
      return res.status(403).json({ error: 'active live-session access required' });
    }

    const currentUser = await getCurrentUserProfile(req.auth.sub);
    const livekit = issueLiveKitSessionCredentials({
      stream: payload.stream,
      userId: req.auth.sub,
      role,
      displayName: currentUser?.display_name
    });

    return res.json({
      stream: payload.stream,
      viewerAccess: payload.viewerAccess,
      livekit
    });
  } catch (error) {
    return res.status(500).json({ error: 'failed to issue live session token' });
  }
});

v1.post('/streams/:id/presence', authRequired, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ls.id, ls.status
       FROM live_session ls
       INNER JOIN creator_profile cp
         ON cp.id = ls.creator_id
       WHERE ls.id = $1
         AND cp.user_id = $2
       LIMIT 1`,
      [req.params.id, req.auth.sub]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'live session not found for current creator' });
    }
    if (result.rows[0].status !== 'live') {
      return res.status(409).json({ error: 'live session is not active' });
    }

    await touchLiveCreatorPresence(req.params.id, req.auth.sub);
    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ error: 'failed to update creator live presence' });
  }
});

v1.post('/streams/:id/join', authRequired, async (req, res) => {
  const client = await pool.connect();
  let committed = false;
  try {
    await client.query('BEGIN');

    const sessionResult = await client.query(
      `SELECT ls.id,
              ls.creator_id,
              ls.room_id,
              ls.status,
              ls.base_join_price_credits,
              ls.extend_duration_seconds,
              ls.max_concurrent_viewers,
              cp.user_id AS creator_user_id
       FROM live_session ls
       INNER JOIN creator_profile cp
         ON cp.id = ls.creator_id
       WHERE ls.id = $1
       LIMIT 1
       FOR UPDATE`,
      [req.params.id]
    );
    if (sessionResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'live session not found' });
    }

    const session = sessionResult.rows[0];
    if (session.status !== 'live') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'live session is not active' });
    }
    if (!(await hasLiveCreatorPresence(session.id))) {
      await endLiveSessionById(session.id, {
        client,
        reason: 'creator_offline',
        viewerUserId: req.auth.sub
      });
      await client.query('COMMIT');
      committed = true;
      return res.status(409).json({ error: 'live session is not active' });
    }

    if (session.creator_user_id === req.auth.sub) {
      await client.query('COMMIT');
      committed = true;
      await touchLiveCreatorPresence(session.id, req.auth.sub);
      const payload = await getLiveSessionById(session.id, req.auth.sub);
      const currentUser = await getCurrentUserProfile(req.auth.sub);
      const livekit = isLiveKitConfigured()
        ? issueLiveKitSessionCredentials({
            stream: payload.stream,
            userId: req.auth.sub,
            role: 'host',
            displayName: currentUser?.display_name
          })
        : null;
      return res.json({ stream: payload.stream, viewerAccess: payload.viewerAccess, joined: false, role: 'host', livekit });
    }

    const existingViewer = await client.query(
      `SELECT id, is_active, joined_at, left_at, watch_expires_at
       FROM live_session_viewer
       WHERE live_session_id = $1
         AND viewer_user_id = $2
       LIMIT 1
       FOR UPDATE`,
      [session.id, req.auth.sub]
    );

    if (!existingViewer.rows[0]?.is_active && session.max_concurrent_viewers) {
      const activeViewers = await client.query(
        `SELECT COUNT(*)::int AS count
         FROM live_session_viewer
         WHERE live_session_id = $1
           AND is_active = TRUE`,
        [session.id]
      );
      if (Number(activeViewers.rows[0].count) >= Number(session.max_concurrent_viewers)) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'live session viewer limit reached' });
      }
    }

    let transfer = null;
    if (!existingViewer.rows[0]?.is_active && Number(session.base_join_price_credits) > 0) {
      transfer = await transferCredits({
        client,
        fromUserId: req.auth.sub,
        toUserId: session.creator_user_id,
        amountCredits: Number(session.base_join_price_credits),
        debitEntryType: 'live_join_debit',
        creditEntryType: 'live_join_credit',
        referenceType: 'live_session_join',
        referenceId: session.id
      });
    }

    let viewer;
    if (existingViewer.rows.length > 0) {
      const updatedViewer = await client.query(
        `UPDATE live_session_viewer
         SET joined_at = now(),
             left_at = NULL,
             watch_expires_at = now() + ($2 * interval '1 second'),
             is_active = TRUE
         WHERE id = $1
         RETURNING id, joined_at, left_at, watch_expires_at, is_active`,
        [existingViewer.rows[0].id, Number(session.extend_duration_seconds)]
      );
      viewer = updatedViewer.rows[0];
    } else {
      const insertedViewer = await client.query(
        `INSERT INTO live_session_viewer (
           live_session_id,
           viewer_user_id,
           joined_at,
           watch_expires_at,
           is_active
         )
         VALUES ($1, $2, now(), now() + ($3 * interval '1 second'), TRUE)
         RETURNING id, joined_at, left_at, watch_expires_at, is_active`,
        [session.id, req.auth.sub, Number(session.extend_duration_seconds)]
      );
      viewer = insertedViewer.rows[0];
    }

    await client.query('COMMIT');
    committed = true;

    const payload = await getLiveSessionById(session.id, req.auth.sub);
    const currentUser = await getCurrentUserProfile(req.auth.sub);
    const livekit = isLiveKitConfigured()
      ? issueLiveKitSessionCredentials({
          stream: payload.stream,
          userId: req.auth.sub,
          role: 'viewer',
          displayName: currentUser?.display_name
        })
      : null;
    if (session.room_id) {
      publishChatEvent(session.room_id, 'live.viewer.joined', {
        liveSessionId: session.id,
        viewerUserId: req.auth.sub
      }).catch((error) => {
        // eslint-disable-next-line no-console
        console.error(error.message);
      });
    }

    return res.json({
      stream: payload.stream,
      viewerAccess: payload.viewerAccess,
      joined: true,
      chargedCredits: transfer ? transfer.amountCredits : 0,
      transfer,
      viewer,
      livekit
    });
  } catch (error) {
    if (!committed) {
      await client.query('ROLLBACK');
    }
    if (error?.code === 'INSUFFICIENT_CREDITS') {
      return res.status(402).json({ error: 'insufficient credits to join live session' });
    }
    return res.status(500).json({ error: 'failed to join live session' });
  } finally {
    client.release();
  }
});

v1.post('/streams/:id/extend', authRequired, async (req, res) => {
  const client = await pool.connect();
  let committed = false;
  try {
    await client.query('BEGIN');

    const sessionResult = await client.query(
      `SELECT ls.id,
              ls.room_id,
              ls.status,
              ls.extend_price_credits,
              ls.extend_duration_seconds,
              cp.user_id AS creator_user_id,
              lsv.id AS viewer_id,
              lsv.is_active,
              lsv.watch_expires_at
       FROM live_session ls
       INNER JOIN creator_profile cp
         ON cp.id = ls.creator_id
       LEFT JOIN live_session_viewer lsv
         ON lsv.live_session_id = ls.id
        AND lsv.viewer_user_id = $2
       WHERE ls.id = $1
       LIMIT 1
       FOR UPDATE`,
      [req.params.id, req.auth.sub]
    );
    if (sessionResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'live session not found' });
    }
    const session = sessionResult.rows[0];

    if (session.creator_user_id === req.auth.sub) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'creator does not need to extend own live access' });
    }
    if (session.status !== 'live') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'live session is not active' });
    }
    if (!(await hasLiveCreatorPresence(session.id))) {
      await endLiveSessionById(session.id, {
        client,
        reason: 'creator_offline',
        viewerUserId: req.auth.sub
      });
      await client.query('COMMIT');
      committed = true;
      return res.status(409).json({ error: 'live session is not active' });
    }
    if (!session.viewer_id || !session.is_active) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'viewer must join live session before extending' });
    }

    let transfer = null;
    if (Number(session.extend_price_credits) > 0) {
      transfer = await transferCredits({
        client,
        fromUserId: req.auth.sub,
        toUserId: session.creator_user_id,
        amountCredits: Number(session.extend_price_credits),
        debitEntryType: 'live_extend_debit',
        creditEntryType: 'live_extend_credit',
        referenceType: 'live_session_extend',
        referenceId: session.id
      });
    }

    const updatedViewer = await client.query(
      `UPDATE live_session_viewer
       SET watch_expires_at = GREATEST(COALESCE(watch_expires_at, now()), now()) + ($2 * interval '1 second'),
           updated_at = now()
       WHERE id = $1
       RETURNING id, joined_at, left_at, watch_expires_at, is_active`,
      [session.viewer_id, Number(session.extend_duration_seconds)]
    );

    await client.query('COMMIT');
    committed = true;

    const payload = await getLiveSessionById(session.id, req.auth.sub);
    if (session.room_id) {
      publishChatEvent(session.room_id, 'live.viewer.extended', {
        liveSessionId: session.id,
        viewerUserId: req.auth.sub,
        chargedCredits: transfer ? transfer.amountCredits : 0,
        watchExpiresAt: updatedViewer.rows[0].watch_expires_at
      }).catch((error) => {
        // eslint-disable-next-line no-console
        console.error(error.message);
      });
    }

    return res.json({
      stream: payload?.stream || null,
      viewerAccess: payload?.viewerAccess || null,
      chargedCredits: transfer ? transfer.amountCredits : 0,
      transfer,
      viewer: updatedViewer.rows[0]
    });
  } catch (error) {
    if (!committed) {
      await client.query('ROLLBACK');
    }
    if (error?.code === 'INSUFFICIENT_CREDITS') {
      return res.status(402).json({ error: 'insufficient credits to extend live session' });
    }
    return res.status(500).json({ error: 'failed to extend live session' });
  } finally {
    client.release();
  }
});

v1.post('/streams/:id/end', authRequired, async (req, res) => {
  const client = await pool.connect();
  let committed = false;
  try {
    await client.query('BEGIN');

    const sessionResult = await client.query(
      `SELECT ls.id, ls.room_id
       FROM live_session ls
       INNER JOIN creator_profile cp
         ON cp.id = ls.creator_id
       WHERE ls.id = $1
         AND cp.user_id = $2
       LIMIT 1
       FOR UPDATE`,
      [req.params.id, req.auth.sub]
    );
    if (sessionResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'live session not found for current creator' });
    }
    const ended = await endLiveSessionById(req.params.id, {
      client,
      reason: 'creator_ended',
      viewerUserId: req.auth.sub
    });

    await client.query('COMMIT');
    committed = true;
    if (ended?.transitioned) {
      await clearLiveCreatorPresence(req.params.id);
      if (ended.roomId) {
        publishChatEvent(ended.roomId, 'live.ended', {
          liveSessionId: req.params.id,
          reason: 'creator_ended'
        }).catch((error) => {
          // eslint-disable-next-line no-console
          console.error(error.message);
        });
      }
    }

    return res.json({ stream: ended?.stream || null });
  } catch (error) {
    if (!committed) {
      await client.query('ROLLBACK');
    }
    return res.status(500).json({ error: 'failed to end live session' });
  } finally {
    client.release();
  }
});

app.use('/api/v1', v1);

app.use((req, res) => {
  res.status(404).json({ error: 'Not Found' });
});

const server = app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`API listening on :${port}`);
});

async function shutdown(signal) {
  // eslint-disable-next-line no-console
  console.log(`Received ${signal}. Shutting down API...`);
  await Promise.allSettled([closePostgres(), closeRedis()]);
  server.close(() => process.exit(0));
}

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
