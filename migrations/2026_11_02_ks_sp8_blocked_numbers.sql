-- KS_SETTINGS_PACK_v1_BLOCKED_NUMBERS - numbers an Admin has blocked, and a log of the calls and texts stopped.
-- What a blocked call hears is in brokerage_settings ('blocked_numbers'). Idempotent: safe to run again.
CREATE TABLE IF NOT EXISTS blocked_numbers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE,
  reason text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS blocked_number_events (
  id bigserial PRIMARY KEY,
  number text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('call', 'text')),
  action text NOT NULL,
  body text,
  twilio_sid text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS blocked_number_events_at_idx ON blocked_number_events (created_at DESC);
