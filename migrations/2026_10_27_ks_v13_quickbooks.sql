-- KS_SERVER_v13_QUICKBOOKS - each licensee connects its own QuickBooks Online; signed media fee agreements become
-- QuickBooks invoices, and funding updates the invoice and records the payment. Safe to run again.
--
-- quickbooks_connection: at most one row (id = 1) - the licensee's QuickBooks company. Tokens are AES-256-GCM
-- encrypted with QBO_TOKEN_ENCRYPTION_KEY before they reach this table (services/quickbooks/qboAuth.ts).
CREATE TABLE IF NOT EXISTS quickbooks_connection (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  realm_id text,
  company_name text,
  environment text,
  access_token_enc text,
  refresh_token_enc text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  status text NOT NULL DEFAULT 'connected',
  last_error text,
  tax_code_id text,
  tax_code_name text,
  item_id text,
  connected_by text,
  connected_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Single-use OAuth state (hashed nonce bound to the admin who started the connect), 10-minute life.
CREATE TABLE IF NOT EXISTS quickbooks_oauth_states (
  nonce_hash text PRIMARY KEY,
  user_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One fee invoice per application. The row is also the outbox: next_attempt_at set = work to do.
--   status       none (not created yet) | open (invoiced) | paid
--   sync_status  queued | ok | retrying | failed (gave up; Retry in the portal queues it again)
CREATE TABLE IF NOT EXISTS quickbooks_invoices (
  application_id text PRIMARY KEY,
  realm_id text,
  customer_id text,
  invoice_id text,
  doc_number text,
  amount numeric(14,2),
  fee_percent numeric(6,3),
  base_amount numeric(14,2),
  funded boolean NOT NULL DEFAULT false,
  payment_id text,
  status text NOT NULL DEFAULT 'none',
  sync_status text NOT NULL DEFAULT 'queued',
  last_error text,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz DEFAULT now(),
  locked_until timestamptz,
  synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS quickbooks_invoices_due_idx ON quickbooks_invoices (next_attempt_at) WHERE next_attempt_at IS NOT NULL;
