-- KS_HUBSPOT_GAPS_1_PAYMENTS - payment links and Canadian pre-authorized debit for broker fees (Growth and Pro).
--
-- The brokerage connects its OWN Stripe account (Stripe Connect, Standard) in Settings > Payments; Keystone is never
-- the merchant. A payment link is a Keystone URL that opens a Stripe Checkout page on the brokerage's account (card or
-- ACSS pre-authorized debit in CAD). Stripe's Connect webhook tells us when it is paid; a paid link on an application
-- with a QuickBooks fee invoice records a QuickBooks payment against that invoice.
-- Idempotent: safe to run on every start.

CREATE TABLE IF NOT EXISTS stripe_connection (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  account_id text,
  status text NOT NULL DEFAULT 'disconnected',
  livemode boolean,
  business_name text,
  country text,
  default_currency text,
  charges_enabled boolean,
  acss_debit_enabled boolean,
  connected_by uuid,
  connected_at timestamptz,
  disconnected_at timestamptz,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stripe_oauth_states (
  state_hash text PRIMARY KEY,
  user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payment_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token text NOT NULL,
  application_id text,
  contact_id uuid,
  description text NOT NULL,
  amount_cents integer NOT NULL CHECK (amount_cents >= 50),
  currency text NOT NULL DEFAULT 'cad',
  methods text[] NOT NULL DEFAULT ARRAY['card', 'acss_debit']::text[],
  status text NOT NULL DEFAULT 'open',
  stripe_account_id text NOT NULL,
  checkout_session_id text,
  checkout_url text,
  checkout_expires_at timestamptz,
  checkout_count integer NOT NULL DEFAULT 0,
  payment_intent_id text,
  payment_method_type text,
  amount_received_cents integer,
  paid_at timestamptz,
  failed_at timestamptz,
  failure_message text,
  cancelled_at timestamptz,
  sent_channels text[] NOT NULL DEFAULT '{}'::text[],
  sent_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  quickbooks_status text NOT NULL DEFAULT 'none',
  quickbooks_payment_id text,
  quickbooks_error text,
  quickbooks_attempts integer NOT NULL DEFAULT 0,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS payment_links_token_uidx ON payment_links (token);
CREATE INDEX IF NOT EXISTS payment_links_application_idx ON payment_links (application_id) WHERE application_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS payment_links_contact_idx ON payment_links (contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS payment_links_session_idx ON payment_links (checkout_session_id) WHERE checkout_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS payment_links_qbo_due_idx ON payment_links (quickbooks_status) WHERE quickbooks_status IN ('pending', 'retrying');

-- Each Stripe event is handled once (Stripe retries deliveries).
CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  event_id text PRIMARY KEY,
  event_type text NOT NULL,
  account_id text,
  received_at timestamptz NOT NULL DEFAULT now()
);
