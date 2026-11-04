-- KS_LENDER_SYNC_CONTRACTS - lender-reported balances on Active Contracts, and lender conditions on the funding
-- checklist. Idempotent: every statement is IF NOT EXISTS or guarded, so running it twice changes nothing.
-- No extensions; runs as the brokerage database's normal (non-superuser) owner.

-- What a lender connector reports with a balance (source 'lender_portal'). The table stays append-only.
ALTER TABLE active_contract_balances ADD COLUMN IF NOT EXISTS lender_name text;
ALTER TABLE active_contract_balances ADD COLUMN IF NOT EXISTS lender_status text;
ALTER TABLE active_contract_balances ADD COLUMN IF NOT EXISTS next_payment_date date;
ALTER TABLE active_contract_balances ADD COLUMN IF NOT EXISTS next_payment_amount numeric(14,2);
ALTER TABLE active_contract_balances ADD COLUMN IF NOT EXISTS submission_id text;
CREATE INDEX IF NOT EXISTS active_contract_balances_lender_idx ON active_contract_balances (contract_id, as_of DESC, created_at DESC) WHERE source = 'lender_portal';

-- When the lender first reported the deal funded (funded deals are read back daily while their contract is open).
ALTER TABLE lender_api_submissions ADD COLUMN IF NOT EXISTS funded_seen_at timestamptz;

-- Funding checklist rows reported by a lender: which lender, and the lender's own id for the condition.
ALTER TABLE funding_conditions ADD COLUMN IF NOT EXISTS lender_id uuid;
ALTER TABLE funding_conditions ADD COLUMN IF NOT EXISTS lender_condition_id text;
ALTER TABLE funding_conditions ADD COLUMN IF NOT EXISTS lender_name text;
ALTER TABLE funding_conditions DROP CONSTRAINT IF EXISTS funding_conditions_source_check;
ALTER TABLE funding_conditions ADD CONSTRAINT funding_conditions_source_check CHECK (source IN ('manual','template','offer','lender'));
-- One row per lender condition per application, so a re-sync never adds it twice.
CREATE UNIQUE INDEX IF NOT EXISTS funding_conditions_lender_once ON funding_conditions (application_id, lender_id, lender_condition_id)
  WHERE lender_condition_id IS NOT NULL;

-- Funded deals whose polling stopped at funding and whose contract is still open: read them again.
UPDATE lender_api_submissions s SET next_poll_at = now(), funded_seen_at = COALESCE(s.funded_seen_at, s.updated_at)
 WHERE s.bucket = 'funded' AND s.next_poll_at IS NULL AND s.external_id IS NOT NULL
   AND EXISTS (SELECT 1 FROM active_contracts c WHERE c.application_id = s.application_id
                 AND (c.lender_id IS NULL OR c.lender_id = s.lender_id)
                 AND c.status NOT IN ('refinanced','paid_out','matured','closed'));
