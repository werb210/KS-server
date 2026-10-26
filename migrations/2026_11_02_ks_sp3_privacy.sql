-- KS_SETTINGS_PACK_v1_PRIVACY - cookie consent choices made on Keystone's public pages (client app, booking pages),
-- and privacy requests (access, correction, deletion) an Admin records against a contact.
-- Idempotent: safe to run again.

CREATE TABLE IF NOT EXISTS cookie_consents (
  id bigserial PRIMARY KEY,
  visitor_id text NOT NULL,
  surface text NOT NULL,
  choice text NOT NULL CHECK (choice IN ('granted', 'denied')),
  categories jsonb NOT NULL DEFAULT '{}'::jsonb,
  policy_version text,
  ip_hash text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cookie_consents_visitor_idx ON cookie_consents (visitor_id, created_at DESC);

CREATE TABLE IF NOT EXISTS privacy_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid,
  contact_label text,
  kind text NOT NULL CHECK (kind IN ('access', 'correction', 'deletion')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed', 'refused')),
  details text,
  received_via text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  due_at timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  outcome jsonb,
  completed_at timestamptz,
  completed_by uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS privacy_requests_open_idx ON privacy_requests (status, due_at);
