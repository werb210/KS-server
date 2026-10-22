-- KS_SERVER_v8_USAGE_OPS - usage metering, the 80% / 100% usage notices, the reports sent to Keystone operations,
-- support tickets relayed to operations, and the licensee's own connection settings. Safe to run again.

-- Outbound texts are not recorded in one place (staff texts, notifications, marketing and the Watch each send their
-- own way), so every Twilio messages.create is counted here: one row per message SID, quantity = segments.
CREATE TABLE IF NOT EXISTS usage_events (
  id bigserial PRIMARY KEY,
  kind text NOT NULL,
  ref text NOT NULL,
  quantity integer NOT NULL DEFAULT 1,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS usage_events_kind_ref_uq ON usage_events (kind, ref);
CREATE INDEX IF NOT EXISTS usage_events_kind_occurred_idx ON usage_events (kind, occurred_at);

-- Once-per-month notice markers: (period, metric, level). A new month has no rows, so the notices reset by themselves.
CREATE TABLE IF NOT EXISTS usage_notices (
  period text NOT NULL,
  metric text NOT NULL,
  level smallint NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (period, metric, level)
);

-- When each period's usage report last reached operations (daily) and when its final report did (after month end).
CREATE TABLE IF NOT EXISTS usage_report_posts (
  period text PRIMARY KEY,
  last_posted_at timestamptz,
  final_posted_at timestamptz,
  last_attempt_at timestamptz,
  last_error text
);

-- Support tickets from the licensee's staff, relayed to Keystone operations.
CREATE TABLE IF NOT EXISTS support_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by text,
  subject text NOT NULL,
  body text NOT NULL,
  priority text NOT NULL DEFAULT 'normal',
  status text NOT NULL DEFAULT 'open',
  ops_ticket_id text,
  relayed_at timestamptz,
  relay_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS relayed_at timestamptz;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS relay_error text;
CREATE INDEX IF NOT EXISTS support_tickets_created_idx ON support_tickets (created_at DESC);

-- The licensee's own accounts (shown to its admins only, never on the public GET /api/licensee).
ALTER TABLE IF EXISTS licensee_settings ADD COLUMN IF NOT EXISTS twilio_main_number text;
ALTER TABLE IF EXISTS licensee_settings ADD COLUMN IF NOT EXISTS google_ads_customer_id text;
ALTER TABLE IF EXISTS licensee_settings ADD COLUMN IF NOT EXISTS office365_tenant_id text;

-- Monthly counts read these by time.
CREATE INDEX IF NOT EXISTS chat_sessions_created_at_idx ON chat_sessions (created_at);
CREATE INDEX IF NOT EXISTS call_logs_started_at_idx ON call_logs (started_at);

-- The licensee's service status, set by Keystone operations through PUT /api/plan { status }:
-- trial | active | past_due -> normal; suspended -> every service stopped (sign-in, the Plan page and Help only);
-- cancelled -> as suspended, plus admins may export their data; the data is purged 180 days after cancelled_at.
ALTER TABLE licensee_plan ADD COLUMN IF NOT EXISTS service_status text NOT NULL DEFAULT 'active';
ALTER TABLE licensee_plan ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
ALTER TABLE licensee_plan ADD COLUMN IF NOT EXISTS purge_warning_7_sent_at timestamptz;
ALTER TABLE licensee_plan ADD COLUMN IF NOT EXISTS purge_warning_1_sent_at timestamptz;
ALTER TABLE licensee_plan ADD COLUMN IF NOT EXISTS purged_at timestamptz;
