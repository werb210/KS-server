-- KS_SETTINGS_PACK_v1_NPS - the post-funding survey (0-10 and a comment) sent to the client after a deal funds, with
-- an optional Google review link for 9-10. One survey per funded application. The settings live in
-- brokerage_settings ('nps'). Idempotent: safe to run again.
CREATE TABLE IF NOT EXISTS nps_surveys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id text NOT NULL UNIQUE,
  contact_id uuid,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'responded', 'skipped', 'failed')),
  due_at timestamptz NOT NULL,
  token_hash text,
  channels text[] NOT NULL DEFAULT '{}',
  sent_at timestamptz,
  skip_reason text,
  score integer CHECK (score BETWEEN 0 AND 10),
  comment text,
  responded_at timestamptz,
  review_link_shown boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS nps_surveys_due_idx ON nps_surveys (status, due_at);
CREATE UNIQUE INDEX IF NOT EXISTS nps_surveys_token_idx ON nps_surveys (token_hash) WHERE token_hash IS NOT NULL;
