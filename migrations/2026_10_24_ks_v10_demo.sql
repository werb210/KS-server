-- KS_SERVER_v10_DEMO - the self-serve sales demo. Only used when the server runs with DEMO_MODE=true (one shared demo
-- server for every prospect). Each prospect is one demo_sessions row; every other demo table carries session_id and
-- is deleted with it (ON DELETE CASCADE), so wiping a session removes everything it made. Safe to run again.

CREATE TABLE IF NOT EXISTS demo_sessions (
  id uuid PRIMARY KEY,
  ops_session_id text NOT NULL,
  prospect_name text NOT NULL,
  prospect_email text NOT NULL,
  company text NOT NULL,
  -- The borrower link code (the QR / short link). A bearer secret derived from the session id with the server's key;
  -- only its SHA-256 is stored, for the lookup.
  client_code_hash text NOT NULL,
  walkthrough jsonb NOT NULL DEFAULT '{}'::jsonb,
  used_phone boolean NOT NULL DEFAULT false,
  used_screen boolean NOT NULL DEFAULT false,
  assistant_questions integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  -- When KS-Ops took the completion (with the lender package) - it then emails the prospect and sales.
  complete_sent_at timestamptz,
  complete_attempts integer NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS demo_sessions_ops_uq ON demo_sessions (ops_session_id);
CREATE UNIQUE INDEX IF NOT EXISTS demo_sessions_code_uq ON demo_sessions (client_code_hash);
CREATE INDEX IF NOT EXISTS demo_sessions_expires_idx ON demo_sessions (expires_at);

-- The sample application (one per session), seeded from the fixture when the session is made.
CREATE TABLE IF NOT EXISTS demo_applications (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES demo_sessions(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'draft',
  business jsonb NOT NULL,
  contact jsonb NOT NULL,
  request jsonb NOT NULL,
  financials jsonb NOT NULL,
  financials_reviewed_at timestamptz,
  credit_summary jsonb,
  selected_lenders jsonb NOT NULL DEFAULT '[]'::jsonb,
  call jsonb,
  notes jsonb NOT NULL DEFAULT '[]'::jsonb,
  borrower_submitted_at timestamptz,
  submitted_at timestamptz,
  package_pdf bytea,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS demo_applications_session_uq ON demo_applications (session_id);

-- Uploaded sample documents (small PDFs, kept in the database so they are wiped with the session).
CREATE TABLE IF NOT EXISTS demo_documents (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES demo_sessions(id) ON DELETE CASCADE,
  application_id uuid NOT NULL REFERENCES demo_applications(id) ON DELETE CASCADE,
  sample_key text NOT NULL,
  category text NOT NULL,
  label text NOT NULL,
  filename text NOT NULL,
  mime_type text NOT NULL,
  size_bytes integer NOT NULL,
  content bytea NOT NULL,
  uploaded_via text NOT NULL DEFAULT 'phone',
  status text NOT NULL DEFAULT 'pending',
  reject_reason text,
  tamper jsonb,
  statement_math jsonb,
  fraud_status text,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS demo_documents_sample_uq ON demo_documents (session_id, sample_key);
CREATE INDEX IF NOT EXISTS demo_documents_session_idx ON demo_documents (session_id);

-- The borrower's questions to the assistant and its answers.
CREATE TABLE IF NOT EXISTS demo_messages (
  id bigserial PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES demo_sessions(id) ON DELETE CASCADE,
  role text NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS demo_messages_session_idx ON demo_messages (session_id, id);

-- Progress events waiting to be sent to KS-Ops (sent_at set once KS-Ops took them).
CREATE TABLE IF NOT EXISTS demo_events (
  id bigserial PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES demo_sessions(id) ON DELETE CASCADE,
  type text NOT NULL,
  step text,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  attempts integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS demo_events_unsent_idx ON demo_events (created_at) WHERE sent_at IS NULL;
CREATE INDEX IF NOT EXISTS demo_events_session_idx ON demo_events (session_id, id);
