-- KS_SERVER_TEAM_IMPORT_v1 - when a person was emailed their Keystone invite (null: added but not invited yet, so the
-- owner can set things up first and invite later from Settings > Users).
ALTER TABLE users ADD COLUMN IF NOT EXISTS invited_at timestamptz;
