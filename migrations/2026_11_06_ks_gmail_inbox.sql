-- KS_SERVER_GMAIL_INBOX - Gmail inbox reading (built, OFF until KS_GOOGLE_GMAIL_READ_ENABLED=true after Google's CASA
-- assessment). Safe to run again. Nothing here reads mail: it only adds the sync bookkeeping.
--
-- google_workspace_accounts: where each person's Gmail sync has got to (Gmail history id), the push watch, errors.
ALTER TABLE IF EXISTS google_workspace_accounts ADD COLUMN IF NOT EXISTS gmail_history_id text;
ALTER TABLE IF EXISTS google_workspace_accounts ADD COLUMN IF NOT EXISTS gmail_initial_sync_at timestamptz;
ALTER TABLE IF EXISTS google_workspace_accounts ADD COLUMN IF NOT EXISTS gmail_watch_expires_at timestamptz;
ALTER TABLE IF EXISTS google_workspace_accounts ADD COLUMN IF NOT EXISTS gmail_last_error text;

-- gmail_messages: one row per Gmail message Keystone logged to the CRM (matched to a contact), never the whole mailbox.
-- It de-duplicates the sync, keeps the thread, and links the message to its contact and application.
CREATE TABLE IF NOT EXISTS gmail_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  gmail_id text NOT NULL,
  thread_id text,
  rfc_message_id text,
  in_reply_to text,
  direction text NOT NULL,
  from_address text,
  to_addresses text[] NOT NULL DEFAULT '{}'::text[],
  cc_addresses text[] NOT NULL DEFAULT '{}'::text[],
  subject text,
  snippet text,
  internal_date timestamptz,
  has_attachments boolean NOT NULL DEFAULT false,
  attachments_filed integer NOT NULL DEFAULT 0,
  contact_id uuid,
  application_id text,
  silo text NOT NULL DEFAULT 'BF',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT gmail_messages_direction_check CHECK (direction IN ('inbound', 'outbound'))
);
CREATE UNIQUE INDEX IF NOT EXISTS gmail_messages_user_gmail_uidx ON gmail_messages (user_id, gmail_id);
CREATE INDEX IF NOT EXISTS gmail_messages_thread_idx ON gmail_messages (thread_id);
CREATE INDEX IF NOT EXISTS gmail_messages_contact_idx ON gmail_messages (contact_id);

-- Portal sends through Gmail keep their Gmail thread, so a client's reply lands in the same conversation.
ALTER TABLE IF EXISTS crm_email_log ADD COLUMN IF NOT EXISTS gmail_thread_id text;
CREATE INDEX IF NOT EXISTS crm_email_log_gmail_thread_idx ON crm_email_log (gmail_thread_id) WHERE gmail_thread_id IS NOT NULL;
