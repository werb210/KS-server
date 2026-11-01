-- KS_SERVER_v23_QUOTES - quotes (offer summaries) staff build for a client from one or more lender offers.
-- A quote has one or more options (each usually from an offer already on the file); the client views it in the client
-- app and accepts one option (typed name + tick, recorded with time and a hashed IP) or declines. Accepting an option
-- that came from an offer stages that offer for acceptance exactly like the offer's own Accept button, so the staff
-- "Confirm acceptance" step and the lender e-signing that follows are unchanged.
CREATE TABLE IF NOT EXISTS quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id text NOT NULL,
  quote_number text NOT NULL,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'sent', 'viewed', 'accepted', 'declined', 'expired', 'withdrawn')),
  title text NOT NULL DEFAULT 'Your financing options',
  message text,
  currency text NOT NULL DEFAULT 'CAD' CHECK (currency IN ('CAD', 'USD')),
  expires_on date,
  pdf_document_id text,
  accepted_option_id uuid,
  accepted_name text,
  accepted_ip_hash text,
  accepted_user_agent text,
  decline_reason text,
  view_count integer NOT NULL DEFAULT 0,
  created_by text,
  sent_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  first_viewed_at timestamptz,
  last_viewed_at timestamptz,
  accepted_at timestamptz,
  declined_at timestamptz,
  withdrawn_at timestamptz
);
CREATE INDEX IF NOT EXISTS quotes_application_idx ON quotes (application_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS quotes_number_uq ON quotes (quote_number);

CREATE TABLE IF NOT EXISTS quote_options (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id uuid NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  position integer NOT NULL DEFAULT 0,
  offer_id text,
  lender_name text NOT NULL,
  product_name text,
  amount numeric(14, 2) NOT NULL,
  term_months numeric(6, 2),
  rate_kind text NOT NULL DEFAULT 'interest_rate' CHECK (rate_kind IN ('interest_rate', 'factor_rate')),
  rate numeric(10, 4),
  payment_frequency text NOT NULL DEFAULT 'monthly'
    CHECK (payment_frequency IN ('daily', 'weekly', 'biweekly', 'semimonthly', 'monthly')),
  payment_count integer,
  payment_amount numeric(14, 2),
  payment_overridden boolean NOT NULL DEFAULT false,
  fees jsonb NOT NULL DEFAULT '[]'::jsonb,
  total_fees numeric(14, 2) NOT NULL DEFAULT 0,
  total_repayment numeric(14, 2),
  cost_of_borrowing numeric(14, 2),
  net_proceeds numeric(14, 2),
  estimated_apr numeric(8, 2),
  recommended boolean NOT NULL DEFAULT false,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS quote_options_quote_idx ON quote_options (quote_id, position);

-- What happened to a quote, for the staff timeline. No personal data in detail.
CREATE TABLE IF NOT EXISTS quote_events (
  id bigserial PRIMARY KEY,
  quote_id uuid NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  kind text NOT NULL,
  actor text NOT NULL DEFAULT 'staff',
  user_id text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS quote_events_quote_idx ON quote_events (quote_id, created_at);
