-- KS_SETTINGS_PACK_v1_SECURITY - signed-in sessions (one row per sign-in; the access token carries its id), so staff
-- see their devices and sign one out, and Admins sign anyone out everywhere. strong = passkey, Face ID on the dialler,
-- single sign-on, or a text code followed by a passkey. Idempotent: safe to run again.
CREATE TABLE IF NOT EXISTS user_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  method text NOT NULL CHECK (method IN ('otp', 'passkey', 'sso', 'device')),
  strong boolean NOT NULL DEFAULT false,
  ip text,
  user_agent text,
  device_label text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by uuid
);
CREATE INDEX IF NOT EXISTS user_sessions_user_idx ON user_sessions (user_id, last_seen_at DESC) WHERE revoked_at IS NULL;
