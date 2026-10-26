-- KS_SETTINGS_PACK_v1_LEAD_ROTATION - who each new lead was given to by the round robin (the next person is whoever
-- was given one least recently). The settings live in brokerage_settings ('lead_rotation'). Idempotent.
CREATE TABLE IF NOT EXISTS lead_rotation_assignments (
  id bigserial PRIMARY KEY,
  contact_id uuid NOT NULL,
  user_id uuid NOT NULL,
  source text NOT NULL,
  assigned_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lead_rotation_assignments_user_idx ON lead_rotation_assignments (user_id, assigned_at DESC);
