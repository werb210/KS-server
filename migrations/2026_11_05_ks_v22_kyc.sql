-- KS_SERVER_v22_KYC - ID and address verification (KYC) of applicants and guarantors.
-- One row per verification request: who it is for, which provider runs it (onfido = hosted document + selfie
-- liveness flow; manual = the applicant uploads ID and a selfie and staff decide), its status and the non-personal
-- reasons. Personal details the vendor read from the ID (name, date of birth, document number, expiry) are kept only
-- encrypted (pii_enc, the same scheme as the SIN), never in plain columns or logs. ID images are stored as documents
-- on the application, so the retention and legal-hold rules cover them like any other upload.
CREATE TABLE IF NOT EXISTS kyc_settings (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  -- NULL = automatic: onfido when it is set up on this server, else manual review.
  provider text CHECK (provider IS NULL OR provider IN ('onfido', 'manual')),
  -- Show "Verify your identity" right after the client submits the application.
  wizard_step boolean NOT NULL DEFAULT false,
  -- Who the wizard step asks: the applicant only, or the applicant and every guarantor on the file.
  wizard_people text NOT NULL DEFAULT 'applicant' CHECK (wizard_people IN ('applicant', 'applicant_and_guarantors')),
  updated_at timestamptz,
  updated_by text
);
INSERT INTO kyc_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS kyc_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id text NOT NULL,
  contact_id text,
  person_role text NOT NULL DEFAULT 'applicant',
  provider text NOT NULL,
  status text NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'in_progress', 'processing', 'approved', 'declined', 'review', 'expired', 'cancelled', 'error')),
  decision_source text,
  reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  checks jsonb NOT NULL DEFAULT '{}'::jsonb,
  vendor_applicant_id text,
  vendor_session_id text,
  session_url_enc bytea,
  session_expires_at timestamptz,
  pii_enc bytea,
  document_ids text[] NOT NULL DEFAULT '{}',
  requested_by text,
  requested_via text NOT NULL DEFAULT 'staff',
  requested_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  reviewed_by text,
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kyc_verifications_app_idx ON kyc_verifications (application_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS kyc_verifications_contact_idx ON kyc_verifications (contact_id);
CREATE UNIQUE INDEX IF NOT EXISTS kyc_verifications_vendor_session_uq
  ON kyc_verifications (provider, vendor_session_id) WHERE vendor_session_id IS NOT NULL;

-- Webhook deliveries already handled (vendor retries are answered 200 without running twice).
CREATE TABLE IF NOT EXISTS kyc_webhook_events (
  provider text NOT NULL,
  event_key text NOT NULL,
  verification_id uuid,
  outcome text,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, event_key)
);
