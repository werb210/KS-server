-- KS_SERVER_v6_PLANS - this copy's plan (starter / growth / pro), its one free 14-day trial, extra storage
-- blocks, the once-only notice markers, and which trial features the brokerage used. Safe to run again.
CREATE TABLE IF NOT EXISTS licensee_plan (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  plan text,
  trial_started_at timestamptz,
  trial_ends_at timestamptz,
  trial_started_by text,
  extra_storage_blocks integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);
ALTER TABLE licensee_plan ADD COLUMN IF NOT EXISTS extra_storage_blocks integer NOT NULL DEFAULT 0;
-- Sent markers: each notice goes out once. The storage ones are cleared when usage drops back below the line.
ALTER TABLE licensee_plan ADD COLUMN IF NOT EXISTS trial_warning_sent_at timestamptz;
ALTER TABLE licensee_plan ADD COLUMN IF NOT EXISTS trial_ended_sent_at timestamptz;
ALTER TABLE licensee_plan ADD COLUMN IF NOT EXISTS storage_80_sent_at timestamptz;
ALTER TABLE licensee_plan ADD COLUMN IF NOT EXISTS storage_100_sent_at timestamptz;

CREATE TABLE IF NOT EXISTS plan_trial_feature_usage (
  feature text PRIMARY KEY,
  uses integer NOT NULL DEFAULT 0,
  first_used_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now()
);
