-- KS_SETTINGS_PACK_v1_NEVER_LOG - email addresses and domains whose mail is never logged to the CRM or auto-filed.
-- Idempotent: safe to run again.
CREATE TABLE IF NOT EXISTS never_log_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  value text NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('email', 'domain')),
  note text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
