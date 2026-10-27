-- KS_SERVER_MARKETING_ADDON - the Marketing add-on, campaign email and e-signing allowances, and the new marketing tools.
-- Idempotent: every statement can run again.
--
-- usage_events (kind, ref, quantity) already exists (2026_10_22_ks_v8_usage_ops.sql); new kinds use it as they are:
--   campaign_email   one marketing email sent (blasts, text fallbacks, sequences)
--   marketing_text   one marketing text sent (text campaigns and sequence texts); also counted as a 'text'
--   signing          one signature request sent to one signer through SignNow

-- One row per person a campaign email went to (or will go to, for each person's best send time). The SendGrid
-- webhook fills opened_at / clicked_at / unsubscribed_at through the cs_id custom argument.
CREATE TABLE IF NOT EXISTS campaign_sends (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  silo text NOT NULL DEFAULT 'BF',
  variant text NOT NULL DEFAULT 'A',
  subject text,
  status text NOT NULL DEFAULT 'sent',
  scheduled_for timestamptz,
  sent_at timestamptz,
  opened_at timestamptz,
  clicked_at timestamptz,
  unsubscribed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT campaign_sends_variant_check CHECK (variant IN ('A', 'B')),
  CONSTRAINT campaign_sends_status_check CHECK (status IN ('scheduled', 'sent', 'failed', 'skipped'))
);
CREATE UNIQUE INDEX IF NOT EXISTS campaign_sends_job_contact_uq ON campaign_sends (job_id, contact_id);
CREATE INDEX IF NOT EXISTS campaign_sends_due_idx ON campaign_sends (job_id, scheduled_for) WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS campaign_sends_contact_idx ON campaign_sends (contact_id, sent_at DESC);

-- Website kit: the lead forms a brokerage puts on its own website. The kit's settings (public key, website
-- addresses, chat widget, tracking) live in brokerage_settings under 'website_kit'.
CREATE TABLE IF NOT EXISTS website_kit_forms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  button_label text NOT NULL DEFAULT 'Send',
  thank_you text NOT NULL DEFAULT 'Thank you. We will be in touch shortly.',
  tag text,
  active boolean NOT NULL DEFAULT true,
  submissions integer NOT NULL DEFAULT 0,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS website_kit_forms_created_idx ON website_kit_forms (created_at);

-- Lead scores: rules (who the person is) plus engagement (what they did lately). The rules live in brokerage_settings
-- under 'lead_scoring'. Refreshed by the lead-score worker and whenever scores are looked up.
CREATE TABLE IF NOT EXISTS lead_scores (
  contact_id uuid PRIMARY KEY,
  score integer NOT NULL DEFAULT 0,
  rules_points integer NOT NULL DEFAULT 0,
  engagement_points integer NOT NULL DEFAULT 0,
  breakdown jsonb NOT NULL DEFAULT '[]'::jsonb,
  computed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lead_scores_score_idx ON lead_scores (score DESC);
