-- KS_SERVER_v12_GOOGLE_WORKSPACE - Google Workspace alongside Microsoft 365. Safe to run again.
--
-- google_workspace_accounts: one row per staff member who connected Google. Tokens are AES-256-GCM encrypted
-- with GOOGLE_TOKEN_ENCRYPTION_KEY before they reach this table (services/workspace/tokenCrypto.ts).
CREATE TABLE IF NOT EXISTS google_workspace_accounts (
  user_id uuid PRIMARY KEY,
  google_email text,
  google_sub text,
  access_token_enc text,
  refresh_token_enc text,
  access_token_expires_at timestamptz,
  scopes text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'connected',
  last_error text,
  gmail_last_synced_at timestamptz,
  connected_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS google_workspace_accounts_status_idx ON google_workspace_accounts (status);

-- Single-use OAuth state (hashed nonce bound to the user) and the PKCE verifier, 10-minute life.
CREATE TABLE IF NOT EXISTS google_oauth_states (
  nonce_hash text PRIMARY KEY,
  user_id text NOT NULL,
  code_verifier text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Company choice: m365 (default, today's behaviour), google or both.
ALTER TABLE IF EXISTS licensee_settings ADD COLUMN IF NOT EXISTS workspace_provider text;

-- Google Drive client folders (drive.file: only folders this app created).
ALTER TABLE IF EXISTS contacts ADD COLUMN IF NOT EXISTS google_drive_folder_id text;
ALTER TABLE IF EXISTS contacts ADD COLUMN IF NOT EXISTS google_drive_folder_url text;

-- Google Tasks mirror, kept apart from the Microsoft To Do columns (graph_id / graph_synced_at).
ALTER TABLE IF EXISTS tasks ADD COLUMN IF NOT EXISTS google_task_id text;
ALTER TABLE IF EXISTS tasks ADD COLUMN IF NOT EXISTS google_synced_at timestamptz;

-- Google Calendar event behind a CRM meeting / client booking (graph_id stays Microsoft's).
ALTER TABLE IF EXISTS crm_meetings ADD COLUMN IF NOT EXISTS google_event_id text;
ALTER TABLE IF EXISTS client_bookings ADD COLUMN IF NOT EXISTS google_event_id text;

-- Gmail sync (built, off until GOOGLE_GMAIL_READ_ENABLED=true): sent mail is de-duplicated per contact.
ALTER TABLE IF EXISTS crm_email_log ADD COLUMN IF NOT EXISTS gmail_message_id text;
CREATE UNIQUE INDEX IF NOT EXISTS crm_email_log_gmail_message_contact_uidx
  ON crm_email_log (gmail_message_id, contact_id) WHERE gmail_message_id IS NOT NULL;
