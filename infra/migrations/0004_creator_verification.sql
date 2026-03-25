BEGIN;

-- Creator onboarding / KYC workflow support.
-- Stores creator verification submissions (with uploaded media references) and admin review outcomes.

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

COMMIT;

