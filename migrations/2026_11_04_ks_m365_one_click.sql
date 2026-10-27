-- KS_SERVER_M365_ONE_CLICK - Microsoft 365 and Google Workspace connect in one click. Safe to run again.

-- The shared mailbox lender packages and notices go out from (Settings > Connections; MS_GRAPH_SEND_AS before).
ALTER TABLE IF EXISTS licensee_settings ADD COLUMN IF NOT EXISTS office365_send_as text;
-- Who connected Microsoft 365 for the company, when, and how (admin consent); office365_tenant_id holds the tenant.
ALTER TABLE IF EXISTS licensee_settings ADD COLUMN IF NOT EXISTS m365_consent jsonb;
-- The last time a Microsoft / Google call worked (shown as "last successful sync").
ALTER TABLE IF EXISTS licensee_settings ADD COLUMN IF NOT EXISTS m365_last_sync_at timestamptz;
ALTER TABLE IF EXISTS licensee_settings ADD COLUMN IF NOT EXISTS google_last_sync_at timestamptz;

-- One table for every Microsoft connect state: 'user' (a staff member's own connect), 'admin_consent' (the Admin's
-- Connect button, cookie-bound, 10 minutes) and 'admin_consent_link' (a link for the Microsoft 365 admin, 7 days).
ALTER TABLE IF EXISTS o365_oauth_states ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'user';
