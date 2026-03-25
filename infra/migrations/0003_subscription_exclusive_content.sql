BEGIN;

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

CREATE INDEX IF NOT EXISTS idx_sub_exclusive_content_creator_status_pub
  ON subscription_exclusive_content(creator_id, status, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_sub_exclusive_content_status_pub
  ON subscription_exclusive_content(status, published_at DESC);

DROP TRIGGER IF EXISTS trg_sub_exclusive_content_updated_at ON subscription_exclusive_content;
CREATE TRIGGER trg_sub_exclusive_content_updated_at
BEFORE UPDATE ON subscription_exclusive_content
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
