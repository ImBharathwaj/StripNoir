-- StripNoir Core Database Schema (PostgreSQL)
-- Purpose: Base schema for users, creators/admins, sessions, credits ledger,
-- content/exclusive access, moderation, live/video sessions, messages, and events.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_status') THEN
    CREATE TYPE user_status AS ENUM ('active', 'suspended', 'banned', 'deleted');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'platform_role') THEN
    CREATE TYPE platform_role AS ENUM ('user', 'creator', 'admin', 'moderator');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'creator_verification_status') THEN
    CREATE TYPE creator_verification_status AS ENUM ('pending', 'approved', 'rejected');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'auth_session_status') THEN
    CREATE TYPE auth_session_status AS ENUM ('active', 'revoked', 'expired');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'media_type') THEN
    CREATE TYPE media_type AS ENUM ('image', 'video', 'audio', 'document');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'content_visibility') THEN
    CREATE TYPE content_visibility AS ENUM ('public', 'followers', 'subscribers', 'exclusive_ppv', 'private');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'content_status') THEN
    CREATE TYPE content_status AS ENUM ('draft', 'published', 'archived', 'deleted');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'subscription_status') THEN
    CREATE TYPE subscription_status AS ENUM ('active', 'cancelled', 'expired', 'paused');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ledger_direction') THEN
    CREATE TYPE ledger_direction AS ENUM ('debit', 'credit');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ledger_entry_type') THEN
    CREATE TYPE ledger_entry_type AS ENUM (
      'deposit',
      'withdrawal',
      'subscription_charge',
      'subscription_payout',
      'tip_debit',
      'tip_credit',
      'live_join_debit',
      'live_join_credit',
      'live_extend_debit',
      'live_extend_credit',
      'video_call_debit',
      'video_call_credit',
      'content_unlock_debit',
      'content_unlock_credit',
      'refund',
      'adjustment',
      'admin_grant',
      'payout_debit',
      'payout_credit',
      'chargeback',
      'reserve_hold',
      'reserve_release'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'payout_status') THEN
    CREATE TYPE payout_status AS ENUM ('requested', 'approved', 'processing', 'paid', 'rejected', 'cancelled');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'room_type') THEN
    CREATE TYPE room_type AS ENUM ('direct', 'group', 'live_session', 'video_call', 'system');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'message_context') THEN
    CREATE TYPE message_context AS ENUM ('direct', 'live_session', 'video_call', 'system');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'message_status') THEN
    CREATE TYPE message_status AS ENUM ('sent', 'edited', 'deleted', 'hidden');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'moderation_status') THEN
    CREATE TYPE moderation_status AS ENUM ('open', 'in_review', 'resolved', 'dismissed');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'moderation_target_type') THEN
    CREATE TYPE moderation_target_type AS ENUM ('user', 'content', 'message', 'live_session', 'video_call_session');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'moderation_action_type') THEN
    CREATE TYPE moderation_action_type AS ENUM ('warn', 'hide_content', 'remove_content', 'mute', 'temporary_ban', 'permanent_ban', 'unban', 'shadowban');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'live_session_status') THEN
    CREATE TYPE live_session_status AS ENUM ('scheduled', 'live', 'ended', 'cancelled');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'video_call_status') THEN
    CREATE TYPE video_call_status AS ENUM ('requested', 'accepted', 'active', 'ended', 'declined', 'cancelled', 'expired');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'event_status') THEN
    CREATE TYPE event_status AS ENUM ('pending', 'processing', 'processed', 'failed');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'notification_type') THEN
    CREATE TYPE notification_type AS ENUM ('system', 'message', 'tip', 'subscription', 'moderation', 'live', 'video_call', 'payout');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'notification_status') THEN
    CREATE TYPE notification_status AS ENUM ('unread', 'read', 'archived');
  END IF;
END $$;

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS user_account (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email CITEXT UNIQUE NOT NULL,
  username CITEXT UNIQUE,
  password_hash TEXT,
  phone_e164 TEXT UNIQUE,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  bio TEXT,
  status user_status NOT NULL DEFAULT 'active',
  email_verified_at TIMESTAMPTZ,
  phone_verified_at TIMESTAMPTZ,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS user_role (
  user_id UUID NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  role platform_role NOT NULL,
  granted_by UUID REFERENCES user_account(id),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role)
);

CREATE TABLE IF NOT EXISTS creator_profile (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID UNIQUE NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  stage_name TEXT NOT NULL,
  about TEXT,
  category_tags TEXT[] NOT NULL DEFAULT '{}',
  is_nsfw BOOLEAN NOT NULL DEFAULT TRUE,
  verification_status creator_verification_status NOT NULL DEFAULT 'pending',
  verified_at TIMESTAMPTZ,
  verified_by UUID REFERENCES user_account(id),
  default_subscription_price_credits INTEGER NOT NULL DEFAULT 0 CHECK (default_subscription_price_credits >= 0),
  live_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  chat_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  video_call_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Creator onboarding / KYC workflow support.
CREATE TABLE IF NOT EXISTS creator_verification_submission (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id UUID NOT NULL REFERENCES creator_profile(id) ON DELETE CASCADE,
  status creator_verification_status NOT NULL DEFAULT 'pending',
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ,
  reviewed_by UUID REFERENCES user_account(id),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_creator_verification_submission_creator_submitted
  ON creator_verification_submission(creator_id, submitted_at DESC);

CREATE TABLE IF NOT EXISTS creator_verification_submission_media (
  creator_verification_submission_id UUID NOT NULL REFERENCES creator_verification_submission(id) ON DELETE CASCADE,
  media_asset_id UUID NOT NULL REFERENCES media_asset(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (creator_verification_submission_id, media_asset_id)
);

CREATE INDEX IF NOT EXISTS idx_creator_verification_submission_media_media
  ON creator_verification_submission_media(media_asset_id);

CREATE TABLE IF NOT EXISTS admin_profile (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID UNIQUE NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  title TEXT,
  permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS auth_session (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  refresh_token_hash TEXT NOT NULL,
  user_agent TEXT,
  ip_address INET,
  device_id TEXT,
  status auth_session_status NOT NULL DEFAULT 'active',
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_block (
  blocker_user_id UUID NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  blocked_user_id UUID NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_user_id, blocked_user_id),
  CHECK (blocker_user_id <> blocked_user_id)
);

CREATE TABLE IF NOT EXISTS follow_relation (
  follower_user_id UUID NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  creator_user_id UUID NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_user_id, creator_user_id),
  CHECK (follower_user_id <> creator_user_id)
);

CREATE TABLE IF NOT EXISTS subscription_plan (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id UUID NOT NULL REFERENCES creator_profile(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  monthly_price_credits INTEGER NOT NULL CHECK (monthly_price_credits >= 0),
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS subscription (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscriber_user_id UUID NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  creator_id UUID NOT NULL REFERENCES creator_profile(id) ON DELETE CASCADE,
  plan_id UUID REFERENCES subscription_plan(id) ON DELETE SET NULL,
  status subscription_status NOT NULL DEFAULT 'active',
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  renewal_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (subscriber_user_id, creator_id)
);

CREATE TABLE IF NOT EXISTS media_asset (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  media_type media_type NOT NULL,
  storage_provider TEXT NOT NULL DEFAULT 's3',
  storage_bucket TEXT,
  object_key TEXT NOT NULL,
  original_filename TEXT,
  mime_type TEXT,
  byte_size BIGINT CHECK (byte_size >= 0),
  checksum_sha256 TEXT,
  width INTEGER CHECK (width >= 0),
  height INTEGER CHECK (height >= 0),
  duration_seconds NUMERIC(10,2) CHECK (duration_seconds >= 0),
  is_public BOOLEAN NOT NULL DEFAULT FALSE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS content_post (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id UUID NOT NULL REFERENCES creator_profile(id) ON DELETE CASCADE,
  title TEXT,
  caption TEXT,
  visibility content_visibility NOT NULL DEFAULT 'subscribers',
  status content_status NOT NULL DEFAULT 'draft',
  requires_payment BOOLEAN NOT NULL DEFAULT FALSE,
  unlock_price_credits INTEGER NOT NULL DEFAULT 0 CHECK (unlock_price_credits >= 0),
  published_at TIMESTAMPTZ,
  scheduled_for TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (requires_payment = FALSE AND unlock_price_credits = 0)
    OR (requires_payment = TRUE AND unlock_price_credits > 0)
  )
);

CREATE TABLE IF NOT EXISTS content_post_media (
  content_post_id UUID NOT NULL REFERENCES content_post(id) ON DELETE CASCADE,
  media_asset_id UUID NOT NULL REFERENCES media_asset(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (content_post_id, media_asset_id)
);

CREATE TABLE IF NOT EXISTS content_access_grant (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content_post_id UUID NOT NULL REFERENCES content_post(id) ON DELETE CASCADE,
  granted_to_user_id UUID NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  grant_source TEXT NOT NULL,
  granted_by_user_id UUID REFERENCES user_account(id),
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (content_post_id, granted_to_user_id)
);

CREATE TABLE IF NOT EXISTS subscription_exclusive_content (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id UUID NOT NULL REFERENCES creator_profile(id) ON DELETE CASCADE,
  title TEXT,
  caption TEXT,
  status content_status NOT NULL DEFAULT 'draft',
  published_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS subscription_exclusive_content_media (
  subscription_exclusive_content_id UUID NOT NULL REFERENCES subscription_exclusive_content(id) ON DELETE CASCADE,
  media_asset_id UUID NOT NULL REFERENCES media_asset(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (subscription_exclusive_content_id, media_asset_id)
);

CREATE TABLE IF NOT EXISTS wallet_account (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID UNIQUE NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  available_credits BIGINT NOT NULL DEFAULT 0 CHECK (available_credits >= 0),
  held_credits BIGINT NOT NULL DEFAULT 0 CHECK (held_credits >= 0),
  lifetime_earned_credits BIGINT NOT NULL DEFAULT 0 CHECK (lifetime_earned_credits >= 0),
  lifetime_spent_credits BIGINT NOT NULL DEFAULT 0 CHECK (lifetime_spent_credits >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS credit_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id UUID NOT NULL REFERENCES wallet_account(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  direction ledger_direction NOT NULL,
  entry_type ledger_entry_type NOT NULL,
  amount_credits BIGINT NOT NULL CHECK (amount_credits > 0),
  balance_before BIGINT,
  balance_after BIGINT,
  counterpart_user_id UUID REFERENCES user_account(id),
  reference_type TEXT,
  reference_id UUID,
  idempotency_key TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS credit_transfer (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  debit_ledger_id UUID UNIQUE REFERENCES credit_ledger(id) ON DELETE SET NULL,
  credit_ledger_id UUID UNIQUE REFERENCES credit_ledger(id) ON DELETE SET NULL,
  transfer_type TEXT NOT NULL,
  amount_credits BIGINT NOT NULL CHECK (amount_credits > 0),
  status TEXT NOT NULL DEFAULT 'completed',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payout_request (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id UUID NOT NULL REFERENCES creator_profile(id) ON DELETE CASCADE,
  requested_credits BIGINT NOT NULL CHECK (requested_credits > 0),
  payout_method TEXT,
  payout_destination_masked TEXT,
  status payout_status NOT NULL DEFAULT 'requested',
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  processed_by UUID REFERENCES user_account(id),
  rejection_reason TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS chat_room (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_type room_type NOT NULL DEFAULT 'direct',
  created_by_user_id UUID REFERENCES user_account(id),
  subject TEXT,
  external_room_key TEXT UNIQUE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chat_room_participant (
  room_id UUID NOT NULL REFERENCES chat_room(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  role_in_room TEXT NOT NULL DEFAULT 'member',
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  left_at TIMESTAMPTZ,
  muted_until TIMESTAMPTZ,
  PRIMARY KEY (room_id, user_id)
);

CREATE TABLE IF NOT EXISTS chat_room_read_state (
  room_id UUID NOT NULL REFERENCES chat_room(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  last_read_message_id UUID,
  last_read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, user_id)
);

CREATE TABLE IF NOT EXISTS message (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID REFERENCES chat_room(id) ON DELETE CASCADE,
  context message_context NOT NULL,
  sender_user_id UUID REFERENCES user_account(id) ON DELETE SET NULL,
  live_session_id UUID,
  video_call_session_id UUID,
  reply_to_message_id UUID REFERENCES message(id) ON DELETE SET NULL,
  body TEXT,
  attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
  status message_status NOT NULL DEFAULT 'sent',
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  edited_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CHECK (
    (context = 'direct' AND room_id IS NOT NULL)
    OR (context = 'live_session' AND live_session_id IS NOT NULL)
    OR (context = 'video_call' AND video_call_session_id IS NOT NULL)
    OR (context = 'system')
  )
);

CREATE TABLE IF NOT EXISTS message_event (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  actor_user_id UUID REFERENCES user_account(id) ON DELETE SET NULL,
  event_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS live_session (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id UUID NOT NULL REFERENCES creator_profile(id) ON DELETE CASCADE,
  room_id UUID REFERENCES chat_room(id) ON DELETE SET NULL,
  livekit_room_name TEXT UNIQUE NOT NULL,
  title TEXT,
  description TEXT,
  stream_thumbnail_url TEXT,
  status live_session_status NOT NULL DEFAULT 'scheduled',
  scheduled_start_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  base_join_price_credits INTEGER NOT NULL DEFAULT 1 CHECK (base_join_price_credits >= 0),
  extend_price_credits INTEGER NOT NULL DEFAULT 1 CHECK (extend_price_credits >= 0),
  extend_duration_seconds INTEGER NOT NULL DEFAULT 120 CHECK (extend_duration_seconds > 0),
  max_concurrent_viewers INTEGER CHECK (max_concurrent_viewers IS NULL OR max_concurrent_viewers > 0),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS live_session_viewer (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  live_session_id UUID NOT NULL REFERENCES live_session(id) ON DELETE CASCADE,
  viewer_user_id UUID NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  left_at TIMESTAMPTZ,
  watch_expires_at TIMESTAMPTZ,
  total_watch_seconds INTEGER NOT NULL DEFAULT 0 CHECK (total_watch_seconds >= 0),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (live_session_id, viewer_user_id)
);

CREATE TABLE IF NOT EXISTS video_call_request (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_user_id UUID NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  target_creator_id UUID NOT NULL REFERENCES creator_profile(id) ON DELETE CASCADE,
  status video_call_status NOT NULL DEFAULT 'requested',
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  decline_reason TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS video_call_session (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID UNIQUE REFERENCES video_call_request(id) ON DELETE SET NULL,
  client_user_id UUID NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  creator_id UUID NOT NULL REFERENCES creator_profile(id) ON DELETE CASCADE,
  room_id UUID REFERENCES chat_room(id) ON DELETE SET NULL,
  livekit_room_name TEXT UNIQUE NOT NULL,
  status video_call_status NOT NULL DEFAULT 'active',
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  credits_per_block INTEGER NOT NULL DEFAULT 1 CHECK (credits_per_block > 0),
  block_duration_seconds INTEGER NOT NULL DEFAULT 120 CHECK (block_duration_seconds > 0),
  total_billed_credits BIGINT NOT NULL DEFAULT 0 CHECK (total_billed_credits >= 0),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS video_call_event (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  video_call_session_id UUID NOT NULL REFERENCES video_call_session(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  actor_user_id UUID REFERENCES user_account(id) ON DELETE SET NULL,
  event_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS moderation_report (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_user_id UUID NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  target_type moderation_target_type NOT NULL,
  target_id UUID NOT NULL,
  reason_code TEXT NOT NULL,
  reason_text TEXT,
  status moderation_status NOT NULL DEFAULT 'open',
  priority SMALLINT NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
  assigned_to UUID REFERENCES user_account(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS moderation_action (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id UUID REFERENCES moderation_report(id) ON DELETE SET NULL,
  actor_admin_user_id UUID NOT NULL REFERENCES user_account(id) ON DELETE RESTRICT,
  target_type moderation_target_type NOT NULL,
  target_id UUID NOT NULL,
  action_type moderation_action_type NOT NULL,
  reason TEXT,
  expires_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin_action_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id UUID NOT NULL REFERENCES user_account(id) ON DELETE RESTRICT,
  action_type TEXT NOT NULL,
  target_type TEXT,
  target_id UUID,
  reason TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notification (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  type notification_type NOT NULL,
  status notification_status NOT NULL DEFAULT 'unread',
  title TEXT,
  body TEXT,
  deep_link TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at TIMESTAMPTZ,
  archived_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS domain_event_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_type TEXT NOT NULL,
  aggregate_id UUID,
  event_type TEXT NOT NULL,
  event_key TEXT,
  payload JSONB NOT NULL,
  status event_status NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_retry_at TIMESTAMPTZ,
  processed_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS idempotency_key (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT UNIQUE NOT NULL,
  request_hash TEXT,
  response_code INTEGER,
  response_body JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_message_live_session'
  ) THEN
    ALTER TABLE message
      ADD CONSTRAINT fk_message_live_session
      FOREIGN KEY (live_session_id) REFERENCES live_session(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_message_video_call_session'
  ) THEN
    ALTER TABLE message
      ADD CONSTRAINT fk_message_video_call_session
      FOREIGN KEY (video_call_session_id) REFERENCES video_call_session(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_room_read_state_message'
  ) THEN
    ALTER TABLE chat_room_read_state
      ADD CONSTRAINT fk_chat_room_read_state_message
      FOREIGN KEY (last_read_message_id) REFERENCES message(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_user_account_status ON user_account(status);
CREATE INDEX IF NOT EXISTS idx_user_account_created_at ON user_account(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_auth_session_user_status ON auth_session(user_id, status);
CREATE INDEX IF NOT EXISTS idx_auth_session_expires_at ON auth_session(expires_at);

CREATE INDEX IF NOT EXISTS idx_creator_profile_verification ON creator_profile(verification_status);

CREATE INDEX IF NOT EXISTS idx_subscription_creator_status ON subscription(creator_id, status);
CREATE INDEX IF NOT EXISTS idx_subscription_subscriber_status ON subscription(subscriber_user_id, status);

CREATE INDEX IF NOT EXISTS idx_media_asset_owner_created ON media_asset(owner_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_content_post_creator_status_pub ON content_post(creator_id, status, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_content_post_visibility_status ON content_post(visibility, status);

CREATE INDEX IF NOT EXISTS idx_content_access_grant_user ON content_access_grant(granted_to_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sub_exclusive_content_creator_status_pub ON subscription_exclusive_content(creator_id, status, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_sub_exclusive_content_status_pub ON subscription_exclusive_content(status, published_at DESC);

CREATE INDEX IF NOT EXISTS idx_wallet_account_user ON wallet_account(user_id);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_user_created ON credit_ledger(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_wallet_created ON credit_ledger(wallet_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_reference ON credit_ledger(reference_type, reference_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_credit_ledger_idempotency_key ON credit_ledger(idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payout_request_creator_status ON payout_request(creator_id, status, requested_at DESC);

CREATE INDEX IF NOT EXISTS idx_chat_room_type_active ON chat_room(room_type, is_active);
CREATE INDEX IF NOT EXISTS idx_chat_room_participant_user ON chat_room_participant(user_id, joined_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_room_read_state_user ON chat_room_read_state(user_id, last_read_at DESC);

CREATE INDEX IF NOT EXISTS idx_message_room_sent ON message(room_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_message_context_live ON message(context, live_session_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_message_context_video ON message(context, video_call_session_id, sent_at DESC);

CREATE INDEX IF NOT EXISTS idx_live_session_creator_status ON live_session(creator_id, status, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_live_session_status_started ON live_session(status, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_live_session_viewer_active ON live_session_viewer(live_session_id, is_active);

CREATE INDEX IF NOT EXISTS idx_video_call_request_target_status ON video_call_request(target_creator_id, status, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_video_call_session_creator_status ON video_call_session(creator_id, status, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_video_call_session_client_status ON video_call_session(client_user_id, status, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_moderation_report_status_priority ON moderation_report(status, priority, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_moderation_report_target ON moderation_report(target_type, target_id);

CREATE INDEX IF NOT EXISTS idx_notification_user_status_created ON notification(user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_outbox_status_created ON domain_event_outbox(status, created_at);
CREATE INDEX IF NOT EXISTS idx_outbox_retry ON domain_event_outbox(next_retry_at) WHERE status = 'failed';

DROP TRIGGER IF EXISTS trg_user_account_updated_at ON user_account;
CREATE TRIGGER trg_user_account_updated_at BEFORE UPDATE ON user_account
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_creator_profile_updated_at ON creator_profile;
CREATE TRIGGER trg_creator_profile_updated_at BEFORE UPDATE ON creator_profile
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_admin_profile_updated_at ON admin_profile;
CREATE TRIGGER trg_admin_profile_updated_at BEFORE UPDATE ON admin_profile
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_auth_session_updated_at ON auth_session;
CREATE TRIGGER trg_auth_session_updated_at BEFORE UPDATE ON auth_session
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_subscription_plan_updated_at ON subscription_plan;
CREATE TRIGGER trg_subscription_plan_updated_at BEFORE UPDATE ON subscription_plan
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_subscription_updated_at ON subscription;
CREATE TRIGGER trg_subscription_updated_at BEFORE UPDATE ON subscription
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_media_asset_updated_at ON media_asset;
CREATE TRIGGER trg_media_asset_updated_at BEFORE UPDATE ON media_asset
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_content_post_updated_at ON content_post;
CREATE TRIGGER trg_content_post_updated_at BEFORE UPDATE ON content_post
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_sub_exclusive_content_updated_at ON subscription_exclusive_content;
CREATE TRIGGER trg_sub_exclusive_content_updated_at BEFORE UPDATE ON subscription_exclusive_content
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_wallet_account_updated_at ON wallet_account;
CREATE TRIGGER trg_wallet_account_updated_at BEFORE UPDATE ON wallet_account
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_chat_room_updated_at ON chat_room;
CREATE TRIGGER trg_chat_room_updated_at BEFORE UPDATE ON chat_room
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_chat_room_read_state_updated_at ON chat_room_read_state;
CREATE TRIGGER trg_chat_room_read_state_updated_at BEFORE UPDATE ON chat_room_read_state
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_live_session_updated_at ON live_session;
CREATE TRIGGER trg_live_session_updated_at BEFORE UPDATE ON live_session
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_video_call_session_updated_at ON video_call_session;
CREATE TRIGGER trg_video_call_session_updated_at BEFORE UPDATE ON video_call_session
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_moderation_report_updated_at ON moderation_report;
CREATE TRIGGER trg_moderation_report_updated_at BEFORE UPDATE ON moderation_report
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
