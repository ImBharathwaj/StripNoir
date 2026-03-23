BEGIN;

CREATE TABLE IF NOT EXISTS chat_room_read_state (
  room_id UUID NOT NULL REFERENCES chat_room(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  last_read_message_id UUID,
  last_read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, user_id)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_room_read_state_message'
  ) THEN
    ALTER TABLE chat_room_read_state
      ADD CONSTRAINT fk_chat_room_read_state_message
      FOREIGN KEY (last_read_message_id) REFERENCES message(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_chat_room_read_state_user ON chat_room_read_state(user_id, last_read_at DESC);

DROP TRIGGER IF EXISTS trg_chat_room_read_state_updated_at ON chat_room_read_state;
CREATE TRIGGER trg_chat_room_read_state_updated_at BEFORE UPDATE ON chat_room_read_state
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
