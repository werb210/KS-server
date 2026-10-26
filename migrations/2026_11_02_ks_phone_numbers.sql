-- KS_SERVER_PHONE_PROVISIONING - phone numbers this copy bought through the Twilio REST API: the main business line(s),
-- the toll-free line and each person's direct line. A number is never released silently: it first moves to
-- 'releasing' with a release_after date (the grace period), the admins are told, and only then is it given back to
-- Twilio. Every step is written to phone_number_events. Safe to run again.
CREATE TABLE IF NOT EXISTS phone_numbers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number text NOT NULL,
  -- main: a local business line. toll_free: the toll-free line (growth and up). direct: one person's line (pro).
  kind text NOT NULL CHECK (kind IN ('main', 'toll_free', 'direct')),
  -- purchasing: the Twilio call is in flight. failed: Twilio refused (see last_error); nothing was bought.
  status text NOT NULL DEFAULT 'purchasing' CHECK (status IN ('purchasing', 'active', 'releasing', 'released', 'failed')),
  twilio_sid text,
  iso_country text,
  locality text,
  region text,
  assigned_user_id uuid,
  release_after timestamptz,
  release_reason text,
  release_attempts int NOT NULL DEFAULT 0,
  released_at timestamptz,
  last_error text,
  purchased_by text,
  purchased_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One live row per number (a released or failed number can be bought again later).
CREATE UNIQUE INDEX IF NOT EXISTS phone_numbers_live_number
  ON phone_numbers (phone_number) WHERE status IN ('purchasing', 'active', 'releasing');
-- One live direct line per person.
CREATE UNIQUE INDEX IF NOT EXISTS phone_numbers_live_direct_user
  ON phone_numbers (assigned_user_id) WHERE kind = 'direct' AND status IN ('purchasing', 'active');
CREATE INDEX IF NOT EXISTS phone_numbers_release_due ON phone_numbers (status, release_after);

CREATE TABLE IF NOT EXISTS phone_number_events (
  id bigserial PRIMARY KEY,
  phone_number_id uuid REFERENCES phone_numbers(id) ON DELETE CASCADE,
  event text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS phone_number_events_number ON phone_number_events (phone_number_id, id);
