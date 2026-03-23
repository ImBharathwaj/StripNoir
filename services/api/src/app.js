const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { checkPostgres, closePostgres } = require('./infra/db');
const { checkRedis, closeRedis } = require('./infra/redis');
const { pool } = require('./infra/db');
require('dotenv').config();

const app = express();
const port = Number(process.env.PORT || 3000);
const accessTokenSecret = process.env.JWT_ACCESS_SECRET || process.env.JWT_SECRET || 'dev_jwt_secret';
const refreshTokenSecret = process.env.JWT_REFRESH_SECRET || `${accessTokenSecret}_refresh`;
const accessTokenTtl = process.env.JWT_ACCESS_TTL || '15m';
const refreshTokenTtl = process.env.JWT_REFRESH_TTL || '30d';
const chatServiceUrl = process.env.CHAT_SERVICE_URL || 'http://localhost:8080';
const chatInternalApiKey = process.env.CHAT_INTERNAL_API_KEY || '';

app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

app.get('/health', (req, res) => {
  res.json({ service: 'api', status: 'ok', port });
});

app.get('/health/deps', async (req, res) => {
  const [postgres, redis] = await Promise.all([checkPostgres(), checkRedis()]);
  const allHealthy = postgres.ok && redis.ok;

  res.status(allHealthy ? 200 : 503).json({
    service: 'api',
    status: allHealthy ? 'ok' : 'degraded',
    dependencies: {
      postgres,
      redis
    }
  });
});

const v1 = express.Router();

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function sanitizeUser(row) {
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    displayName: row.display_name,
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
    videoCallEnabled: row.video_call_enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
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

v1.post('/auth/register', async (req, res) => {
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

v1.post('/auth/login', async (req, res) => {
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

v1.post('/auth/refresh', async (req, res) => {
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
      `SELECT id, email, username, display_name, status, created_at
       FROM user_account
       WHERE id = $1
       LIMIT 1`,
      [req.auth.sub]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'user not found' });
    }
    return res.json({ user: sanitizeUser(result.rows[0]) });
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
        avatarUrl: row.avatar_url,
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
        avatarUrl: row.avatar_url,
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
      `INSERT INTO follow_relation (follower_user_id, creator_user_id)
       VALUES ($1, $2)
       ON CONFLICT (follower_user_id, creator_user_id) DO NOTHING`,
      [req.auth.sub, targetUserId]
    );
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
        avatarUrl: creator.avatar_url,
        bio: creator.bio
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
  const liveEnabled = req.body?.liveEnabled !== undefined ? Boolean(req.body.liveEnabled) : null;
  const videoCallEnabled = req.body?.videoCallEnabled !== undefined ? Boolean(req.body.videoCallEnabled) : null;

  try {
    const updated = await pool.query(
      `UPDATE creator_profile
       SET stage_name = COALESCE($1, stage_name),
           about = CASE WHEN $2::text IS NULL THEN about ELSE $2::text END,
           category_tags = CASE WHEN $3::text[] IS NULL THEN category_tags ELSE $3::text[] END,
           default_subscription_price_credits = COALESCE($4, default_subscription_price_credits),
           live_enabled = COALESCE($5, live_enabled),
           video_call_enabled = COALESCE($6, video_call_enabled),
           updated_at = now()
       WHERE user_id = $7
       RETURNING *`,
      [stageName, about, categoryTags, defaultSubscriptionPriceCredits, liveEnabled, videoCallEnabled, req.auth.sub]
    );
    if (updated.rows.length === 0) {
      return res.status(404).json({ error: 'creator profile not found' });
    }
    return res.json({ creator: sanitizeCreator(updated.rows[0]) });
  } catch (error) {
    return res.status(500).json({ error: 'failed to update creator profile' });
  }
});

v1.post('/creators/subscription', authRequired, async (req, res) => {
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

v1.post('/media/upload-url', authRequired, async (req, res) => {
  const objectKey = `uploads/${req.auth.sub}/${crypto.randomUUID()}`;
  return res.json({
    objectKey,
    uploadUrl: `https://upload.local/${objectKey}`,
    expiresInSeconds: 900
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
        req.body?.storageProvider ? String(req.body.storageProvider).trim() : null,
        req.body?.storageBucket ? String(req.body.storageBucket).trim() : null,
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
    if (!media.is_public && media.owner_user_id !== req.auth.sub) {
      return res.status(403).json({ error: 'forbidden' });
    }
    return res.json({ media });
  } catch (error) {
    return res.status(500).json({ error: 'failed to fetch media' });
  }
});

v1.post('/content/upload-url', authRequired, async (req, res) => {
  const objectKey = `content/${req.auth.sub}/${crypto.randomUUID()}`;
  return res.json({
    objectKey,
    uploadUrl: `https://upload.local/${objectKey}`,
    expiresInSeconds: 900
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

    let hasAccess = content.creator_user_id === req.auth.sub;
    if (!hasAccess) {
      if (content.status !== 'published') {
        return res.status(403).json({ error: 'content is not published' });
      }

      if (content.visibility === 'public') {
        hasAccess = true;
      } else if (content.visibility === 'followers') {
        const follow = await pool.query(
          `SELECT 1 FROM follow_relation WHERE follower_user_id = $1 AND creator_user_id = $2 LIMIT 1`,
          [req.auth.sub, content.creator_user_id]
        );
        hasAccess = follow.rows.length > 0;
      } else if (content.visibility === 'subscribers') {
        const subscription = await pool.query(
          `SELECT 1
           FROM subscription
           WHERE subscriber_user_id = $1
             AND creator_id = $2
             AND status = 'active'
             AND (current_period_end IS NULL OR current_period_end > now())
           LIMIT 1`,
          [req.auth.sub, content.creator_id]
        );
        hasAccess = subscription.rows.length > 0;
      }
    }

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
       ORDER BY COALESCE(published_at, created_at) DESC
       LIMIT $3`,
      [creatorId, isOwner, limit]
    );

    return res.json({ content: result.rows.map(sanitizeContent) });
  } catch (error) {
    return res.status(500).json({ error: 'failed to fetch creator content' });
  }
});

v1.get('/feed', authRequired, async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit || 20), 1), 100);

  try {
    const result = await pool.query(
      `SELECT cp.id, cp.creator_id, cp.title, cp.caption, cp.visibility, cp.status, cp.requires_payment, cp.unlock_price_credits, cp.published_at, cp.scheduled_for, cp.metadata, cp.created_at, cp.updated_at
       FROM content_post cp
       INNER JOIN creator_profile c ON c.id = cp.creator_id
       INNER JOIN follow_relation fr ON fr.creator_user_id = c.user_id
       WHERE fr.follower_user_id = $1
         AND cp.status = 'published'
       ORDER BY cp.published_at DESC NULLS LAST, cp.created_at DESC
       LIMIT $2`,
      [req.auth.sub, limit]
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
       ORDER BY cp.published_at DESC NULLS LAST, cp.created_at DESC
       LIMIT $2`,
      [req.auth.sub, limit]
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
         AND cp.visibility IN ('public', 'followers')
       GROUP BY cp.id
       ORDER BY COUNT(cpm.media_asset_id) DESC, cp.published_at DESC NULLS LAST
       LIMIT $1`,
      [limit]
    );
    return res.json({ feed: result.rows.map(sanitizeContent) });
  } catch (error) {
    return res.status(500).json({ error: 'failed to fetch trending feed' });
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

    await client.query('COMMIT');
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

    await client.query(
      `INSERT INTO notification (user_id, type, title, body, payload)
       VALUES ($1, 'tip', 'New tip received', $2, $3::jsonb)`,
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
    wsUrl: `${chatServiceUrl}/ws?token=${token}&roomId=${roomId}`,
    longPollUrl: `${chatServiceUrl}/realtime/rooms/${roomId}/events?token=${token}`
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

v1.post('/chat/rooms', authRequired, async (req, res) => {
  const participantUserId = String(req.body?.participantUserId || '').trim();
  if (!participantUserId) {
    return res.status(400).json({ error: 'participantUserId is required' });
  }
  if (participantUserId === req.auth.sub) {
    return res.status(400).json({ error: 'participantUserId must be different from current user' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

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

  try {
    if (!(await isRoomParticipant(roomId, req.auth.sub))) {
      return res.status(403).json({ error: 'not a participant of this room' });
    }

    const result = await pool.query(
      `SELECT id, room_id, sender_user_id, body, attachments, status, sent_at, edited_at, deleted_at
       FROM message
       WHERE room_id = $1
         AND context = 'direct'
         AND ($2::timestamptz IS NULL OR sent_at < $2::timestamptz)
       ORDER BY sent_at DESC
       LIMIT $3`,
      [roomId, beforeValue, limit]
    );

    return res.json({
      messages: result.rows.reverse()
    });
  } catch (error) {
    return res.status(500).json({ error: 'failed to fetch messages' });
  }
});

v1.post('/chat/rooms/:id/messages', authRequired, async (req, res) => {
  const roomId = req.params.id;
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

    const inserted = await pool.query(
      `INSERT INTO message (room_id, context, sender_user_id, body, attachments, status)
       VALUES ($1, 'direct', $2, $3, '[]'::jsonb, 'sent')
       RETURNING id, room_id, sender_user_id, body, attachments, status, sent_at, edited_at, deleted_at`,
      [roomId, req.auth.sub, body]
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

v1.post('/chat/rooms/:id/read', authRequired, async (req, res) => {
  const roomId = req.params.id;
  const lastReadMessageId = req.body?.lastReadMessageId ? String(req.body.lastReadMessageId) : null;

  try {
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

v1.get('/streams/live', (req, res) => {
  res.json({ streams: [], message: 'Stub live list endpoint.' });
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
