-- KS_SETTINGS_PACK_v1_PHONE_MENU - the brokerage's own phone menu (IVR), edited in Settings > Phone menu.
-- Idempotent: safe to run again.
--
-- phone_menu_config holds one row (id = 1): the menu as JSON (see src/phoneMenu/menu.ts). No row means the default
-- menu, built from the brokerage's own active staff. phone_menu_audio holds uploaded greeting recordings, played to
-- callers through GET /api/webhooks/twilio/reception/audio/:id.

CREATE TABLE IF NOT EXISTS phone_menu_config (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  config jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);

CREATE TABLE IF NOT EXISTS phone_menu_audio (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_name text,
  content_type text NOT NULL,
  size_bytes integer NOT NULL,
  bytes bytea NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- KS_SETTINGS_PACK_v1 - brokerage-wide switches set by an Admin (lead rotation, blocked-number handling, two-step
-- sign-in, the post-funding survey...). One JSON value per key; see src/settingsPack/common.ts.
CREATE TABLE IF NOT EXISTS brokerage_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);
