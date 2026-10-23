-- KS_SERVER_v11_PGI - Personal Guarantee Insurance referrals to the insurance partner (Boreal Insurance). Every
-- licensee is a referral source paid 20% of the partner's commission on each bound policy. Safe to run again.

-- The link to the partner, set by Keystone operations (PUT /api/pgi/link). Secrets are AES-256-GCM encrypted.
CREATE TABLE IF NOT EXISTS pgi_partner_link (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  bi_server_url text NOT NULL,
  referral_source_id text NOT NULL,
  api_key_enc text NOT NULL,
  callback_secret_enc text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);

-- One referral per application that ticked PGI.
CREATE TABLE IF NOT EXISTS pgi_referrals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending',
  partner_status text,
  bi_application_id text,
  bi_application_code text,
  completion_url text,
  referring_user_id uuid,
  input jsonb NOT NULL DEFAULT '{}'::jsonb,
  checklist jsonb,
  missing_count integer NOT NULL DEFAULT 0,
  unread_count integer NOT NULL DEFAULT 0,
  referral_fee_amount numeric(14,2),
  referral_fee_currency text,
  referral_fee_status text,
  last_error text,
  last_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pgi_referrals_status_idx ON pgi_referrals (status);

-- Documents forwarded to the partner (one row per licensee document; sha256 detects a replaced file).
CREATE TABLE IF NOT EXISTS pgi_referral_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referral_id uuid NOT NULL REFERENCES pgi_referrals(id) ON DELETE CASCADE,
  document_id text NOT NULL,
  slot text NOT NULL,
  sha256 text,
  bi_document_id text,
  forwarded_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (referral_id, document_id)
);

-- The message thread with the partner. bi_event_id dedupes callbacks (a retried delivery is stored once).
CREATE TABLE IF NOT EXISTS pgi_referral_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referral_id uuid NOT NULL REFERENCES pgi_referrals(id) ON DELETE CASCADE,
  direction text NOT NULL CHECK (direction IN ('from_partner', 'to_partner')),
  kind text NOT NULL DEFAULT 'message',
  body text NOT NULL,
  author_name text,
  author_user_id uuid,
  missing jsonb,
  status text,
  bi_event_id text UNIQUE,
  sent_at timestamptz,
  send_error text,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pgi_referral_messages_referral_idx ON pgi_referral_messages (referral_id, created_at);
