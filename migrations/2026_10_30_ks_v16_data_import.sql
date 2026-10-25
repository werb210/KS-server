-- KS_SERVER_v16_DATA_IMPORT - the admin "Import data" wizard (src/import/, src/routes/dataImport.ts): a licensee moving
-- in from HubSpot, Salesforce, Pipedrive, a spreadsheet or a Keystone export zip. Safe to run again.
--
-- import_batches: one upload and everything done with it (dry run, run, undo). The uploaded file lives in blob
-- storage (file_key). status:
--   uploaded | dry_run_queued | dry_running | ready | queued | running | completed | failed
--   | undo_queued | undoing | undone
-- processed_rows is committed together with each chunk of rows, so an interrupted run resumes where it stopped.
CREATE TABLE IF NOT EXISTS import_batches (
  id uuid PRIMARY KEY,
  silo text NOT NULL DEFAULT 'BF',
  source text NOT NULL,
  record_type text NOT NULL,
  file_name text,
  file_key text,
  file_kind text,
  file_size bigint,
  status text NOT NULL DEFAULT 'uploaded',
  columns jsonb NOT NULL DEFAULT '[]'::jsonb,
  mapping jsonb NOT NULL DEFAULT '{}'::jsonb,
  options jsonb NOT NULL DEFAULT '{}'::jsonb,
  total_rows integer NOT NULL DEFAULT 0,
  processed_rows integer NOT NULL DEFAULT 0,
  created_count integer NOT NULL DEFAULT 0,
  updated_count integer NOT NULL DEFAULT 0,
  skipped_count integer NOT NULL DEFAULT 0,
  error_count integer NOT NULL DEFAULT 0,
  dry_run jsonb,
  run_summary jsonb,
  undo_summary jsonb,
  last_error text,
  created_by text,
  created_by_email text,
  heartbeat_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS import_batches_status_idx ON import_batches (status, updated_at);
CREATE INDEX IF NOT EXISTS import_batches_silo_idx ON import_batches (silo, created_at DESC);

-- Every row the import created or changed, in order. action = created | updated. For an update, before holds the
-- previous values of only the columns the import changed and after what it wrote, so undo restores a field only
-- while it still holds the imported value. blob_name: the stored file a created document row points at.
CREATE TABLE IF NOT EXISTS import_batch_items (
  id bigserial PRIMARY KEY,
  batch_id uuid NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  entity_table text NOT NULL,
  entity_id text NOT NULL,
  action text NOT NULL,
  before jsonb,
  after jsonb,
  blob_name text,
  undone_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS import_batch_items_batch_idx ON import_batch_items (batch_id, id);

-- Row errors (level error) and warnings (level warning), for the preview, the dry run and the run (phase), downloadable as CSV.
CREATE TABLE IF NOT EXISTS import_batch_errors (
  id bigserial PRIMARY KEY,
  batch_id uuid NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  phase text NOT NULL,
  level text NOT NULL DEFAULT 'error',
  record_type text,
  row_number integer,
  field text,
  message text NOT NULL,
  raw jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS import_batch_errors_batch_idx ON import_batch_errors (batch_id, phase, id);

-- The source system's id for each imported record, so later files link to it (a deal naming its contact's
-- HubSpot id) and a second import of the same file updates instead of duplicating.
CREATE TABLE IF NOT EXISTS import_external_ids (
  id bigserial PRIMARY KEY,
  silo text NOT NULL DEFAULT 'BF',
  source_system text NOT NULL,
  record_type text NOT NULL,
  external_id text NOT NULL,
  entity_table text NOT NULL,
  entity_id text NOT NULL,
  batch_id uuid REFERENCES import_batches(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS import_external_ids_key_uq
  ON import_external_ids (silo, source_system, record_type, external_id);
CREATE INDEX IF NOT EXISTS import_external_ids_entity_idx ON import_external_ids (entity_table, entity_id);

-- Saved column mappings, reused for the next file from the same system.
CREATE TABLE IF NOT EXISTS import_mappings (
  id uuid PRIMARY KEY,
  silo text NOT NULL DEFAULT 'BF',
  name text NOT NULL,
  source text NOT NULL,
  record_type text NOT NULL,
  mapping jsonb NOT NULL DEFAULT '{}'::jsonb,
  options jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS import_mappings_name_uq ON import_mappings (silo, record_type, lower(name));

-- Matching an imported contact to an existing one by email, or by the last 10 digits of the phone, and a company by
-- name, all within the silo (what the CRM import does), without a full scan per row.
CREATE INDEX IF NOT EXISTS contacts_silo_lower_email_idx ON contacts (silo, lower(email)) WHERE email IS NOT NULL AND email <> '';
CREATE INDEX IF NOT EXISTS contacts_silo_phone_last10_idx
  ON contacts (silo, right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10))
  WHERE phone IS NOT NULL AND phone <> '';
CREATE INDEX IF NOT EXISTS companies_silo_lower_name_idx ON companies (silo, lower(name));
CREATE INDEX IF NOT EXISTS lenders_lower_name_idx ON lenders (lower(name));
