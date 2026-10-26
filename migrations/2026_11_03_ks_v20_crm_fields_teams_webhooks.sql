-- KS_SERVER_v20_CRM_FIELDS_TEAMS_WEBHOOKS - three HubSpot-parity features. Safe to run again.
--
-- 1. Custom fields (every plan): admin-defined properties on contacts, companies and applications. The definitions
--    live in custom_field_definitions; each record keeps its values in its own custom_fields jsonb column, keyed by the
--    field's internal name, so lists can show and filter them and the data export carries them with the record.
--    Definitions are archived, never deleted (archived values stay on the records and come back on unarchive).
-- 2. Teams and record visibility (Growth and Pro): sales_teams / sales_team_members (named so they never collide with
--    the team chat's team_* tables), users.primary_team_id, and who sees which records: per role
--    (role_record_visibility) with an optional per-user override (users.record_visibility). all | team | own.
--    Nothing is restricted until an admin changes a setting.
-- 3. Outgoing webhooks (Pro): webhook_endpoints, their signing secrets in webhook_endpoint_secrets (kept out of the
--    data export, which skips *_secrets tables), and the durable outbox webhook_deliveries. Row triggers on contacts,
--    companies, applications, documents and crm_notes write one delivery per subscribed endpoint in the same
--    transaction as the change, so an event is never lost and every write path (portal, importer, automations, client
--    app, workers) is covered. The triggers do nothing when no endpoint is subscribed, and never fail the write.

-- 1. Custom fields ---------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS custom_field_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object_type text NOT NULL,
  name text NOT NULL,
  label text NOT NULL,
  field_type text NOT NULL,
  options jsonb NOT NULL DEFAULT '[]'::jsonb,
  required boolean NOT NULL DEFAULT false,
  group_name text,
  description text,
  sort_order integer NOT NULL DEFAULT 0,
  archived_at timestamptz,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT custom_field_definitions_object_check CHECK (object_type IN ('contact', 'company', 'application')),
  CONSTRAINT custom_field_definitions_type_check CHECK (field_type IN
    ('text', 'long_text', 'number', 'money', 'date', 'single_select', 'multi_select', 'checkbox', 'url', 'email', 'phone')),
  CONSTRAINT custom_field_definitions_name_check CHECK (name ~ '^[a-z][a-z0-9_]{0,62}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS custom_field_definitions_name_uq ON custom_field_definitions (object_type, name);
CREATE INDEX IF NOT EXISTS custom_field_definitions_order_idx ON custom_field_definitions (object_type, sort_order, created_at);

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS custom_fields jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS custom_fields jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS custom_fields jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX IF NOT EXISTS contacts_custom_fields_gin ON contacts USING gin (custom_fields jsonb_path_ops);
CREATE INDEX IF NOT EXISTS companies_custom_fields_gin ON companies USING gin (custom_fields jsonb_path_ops);
CREATE INDEX IF NOT EXISTS applications_custom_fields_gin ON applications USING gin (custom_fields jsonb_path_ops);

-- 2. Teams and record visibility -------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sales_teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  archived_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS sales_teams_name_uq ON sales_teams (lower(name)) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS sales_team_members (
  team_id uuid NOT NULL REFERENCES sales_teams(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_by uuid,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX IF NOT EXISTS sales_team_members_user_idx ON sales_team_members (user_id);

ALTER TABLE users ADD COLUMN IF NOT EXISTS primary_team_id uuid;
ALTER TABLE users ADD COLUMN IF NOT EXISTS record_visibility text;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_record_visibility_check') THEN
    ALTER TABLE users ADD CONSTRAINT users_record_visibility_check
      CHECK (record_visibility IS NULL OR record_visibility IN ('all', 'team', 'own'));
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS role_record_visibility (
  role text PRIMARY KEY,
  visibility text NOT NULL DEFAULT 'all',
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT role_record_visibility_check CHECK (visibility IN ('all', 'team', 'own'))
);

-- 3. Outgoing webhooks -----------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  url text NOT NULL,
  description text,
  events text[] NOT NULL DEFAULT '{}'::text[],
  -- active | paused (by an admin) | disabled (by Keystone after repeated failures)
  status text NOT NULL DEFAULT 'active',
  consecutive_failures integer NOT NULL DEFAULT 0,
  disabled_at timestamptz,
  disabled_reason text,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT webhook_endpoints_status_check CHECK (status IN ('active', 'paused', 'disabled'))
);
CREATE INDEX IF NOT EXISTS webhook_endpoints_events_idx ON webhook_endpoints USING gin (events) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS webhook_endpoint_secrets (
  endpoint_id uuid PRIMARY KEY REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  secret text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- status: pending (waiting for its first or next attempt) | sending (claimed by the worker) | succeeded | dead (gave up)
-- | skipped (the endpoint was paused, disabled or deleted before it went out)
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL,
  endpoint_id uuid NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  object_type text,
  object_id text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  last_attempt_at timestamptz,
  last_status_code integer,
  last_error text,
  last_duration_ms integer,
  delivered_at timestamptz,
  resend_of uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS webhook_deliveries_due_idx ON webhook_deliveries (next_attempt_at) WHERE status IN ('pending', 'sending');
CREATE INDEX IF NOT EXISTS webhook_deliveries_endpoint_idx ON webhook_deliveries (endpoint_id, created_at DESC);
CREATE INDEX IF NOT EXISTS webhook_deliveries_created_idx ON webhook_deliveries (created_at);

-- Writes one delivery per active endpoint subscribed to the event. Never raises: a webhook problem must not fail the
-- contact, application or note write that fired it.
CREATE OR REPLACE FUNCTION ks_webhook_enqueue(p_event text, p_object_type text, p_object_id text, p_object jsonb, p_extra jsonb)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_event_id uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM webhook_endpoints WHERE status = 'active' AND p_event = ANY(events)) THEN
    RETURN;
  END IF;
  v_event_id := gen_random_uuid();
  INSERT INTO webhook_deliveries (event_id, endpoint_id, event_type, object_type, object_id, payload, occurred_at)
  SELECT v_event_id, e.id, p_event, p_object_type, p_object_id,
         jsonb_build_object('object', p_object, 'extra', COALESCE(p_extra, '{}'::jsonb)), now()
    FROM webhook_endpoints e
   WHERE e.status = 'active' AND p_event = ANY(e.events);
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'ks_webhook_enqueue % failed: %', p_event, SQLERRM;
END
$$;

-- Columns never stored in a delivery (secrets, large internals). The payload sent is further narrowed in
-- src/outboundWebhooks/payload.ts.
CREATE OR REPLACE FUNCTION ks_webhook_row(p_row jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT p_row - ARRAY['ssn_encrypted', 'metadata', 'ocr_missing_fields', 'ocr_conflicting_fields', 'ocr_normalized_values',
                       'lender_matches', 'lender_matches_inputs', 'lender_matches_missing_inputs', 'fraud_evidence',
                       'tamper_signals', 'package_zip', 'package_mail', 'onedrive_folder_id', 'onedrive_drive_id']
$$;

CREATE OR REPLACE FUNCTION ks_webhook_capture() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_ignore text[] := ARRAY['updated_at', 'last_updated', 'line_type', 'line_type_checked_at', 'outlook_contact_id',
                           'onedrive_folder_id', 'onedrive_drive_id', 'onedrive_folder_url', 'last_portal_seen_at'];
  v_new jsonb;
  v_old jsonb;
BEGIN
  -- Cheap exit when nobody listens (one indexed lookup).
  IF NOT EXISTS (SELECT 1 FROM webhook_endpoints WHERE status = 'active') THEN
    RETURN NULL;
  END IF;
  v_new := to_jsonb(NEW);
  IF TG_TABLE_NAME = 'contacts' THEN
    IF TG_OP = 'INSERT' THEN
      PERFORM ks_webhook_enqueue('contact.created', 'contact', NEW.id::text, ks_webhook_row(v_new), NULL);
    ELSE
      v_old := to_jsonb(OLD);
      IF (v_new - v_ignore) IS DISTINCT FROM (v_old - v_ignore) THEN
        PERFORM ks_webhook_enqueue('contact.updated', 'contact', NEW.id::text, ks_webhook_row(v_new), NULL);
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'companies' THEN
    IF TG_OP = 'INSERT' THEN
      PERFORM ks_webhook_enqueue('company.created', 'company', NEW.id::text, ks_webhook_row(v_new), NULL);
    ELSE
      v_old := to_jsonb(OLD);
      IF (v_new - v_ignore) IS DISTINCT FROM (v_old - v_ignore) THEN
        PERFORM ks_webhook_enqueue('company.updated', 'company', NEW.id::text, ks_webhook_row(v_new), NULL);
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'applications' THEN
    IF TG_OP = 'INSERT' THEN
      PERFORM ks_webhook_enqueue('application.created', 'application', NEW.id::text, ks_webhook_row(v_new), NULL);
    ELSE
      v_old := to_jsonb(OLD);
      IF (v_new->>'pipeline_state') IS DISTINCT FROM (v_old->>'pipeline_state') THEN
        PERFORM ks_webhook_enqueue('application.stage_changed', 'application', NEW.id::text, ks_webhook_row(v_new),
          jsonb_build_object('from_stage', v_old->>'pipeline_state', 'to_stage', v_new->>'pipeline_state'));
      END IF;
      IF (v_old->>'signnow_app_signed_at') IS NULL AND (v_new->>'signnow_app_signed_at') IS NOT NULL THEN
        PERFORM ks_webhook_enqueue('application.signed', 'application', NEW.id::text, ks_webhook_row(v_new), NULL);
      END IF;
      IF (v_old->>'funded_at') IS NULL AND (v_new->>'funded_at') IS NOT NULL THEN
        PERFORM ks_webhook_enqueue('deal.funded', 'application', NEW.id::text, ks_webhook_row(v_new), NULL);
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'documents' THEN
    PERFORM ks_webhook_enqueue('document.uploaded', 'document', NEW.id::text, ks_webhook_row(v_new), NULL);
  ELSIF TG_TABLE_NAME = 'crm_notes' THEN
    PERFORM ks_webhook_enqueue('note.added', 'note', NEW.id::text, ks_webhook_row(v_new), NULL);
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'ks_webhook_capture on % failed: %', TG_TABLE_NAME, SQLERRM;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS ks_webhook_contacts ON contacts;
CREATE TRIGGER ks_webhook_contacts AFTER INSERT OR UPDATE ON contacts FOR EACH ROW EXECUTE FUNCTION ks_webhook_capture();
DROP TRIGGER IF EXISTS ks_webhook_companies ON companies;
CREATE TRIGGER ks_webhook_companies AFTER INSERT OR UPDATE ON companies FOR EACH ROW EXECUTE FUNCTION ks_webhook_capture();
DROP TRIGGER IF EXISTS ks_webhook_applications ON applications;
CREATE TRIGGER ks_webhook_applications AFTER INSERT OR UPDATE ON applications FOR EACH ROW EXECUTE FUNCTION ks_webhook_capture();
DROP TRIGGER IF EXISTS ks_webhook_documents ON documents;
CREATE TRIGGER ks_webhook_documents AFTER INSERT ON documents FOR EACH ROW EXECUTE FUNCTION ks_webhook_capture();
DROP TRIGGER IF EXISTS ks_webhook_crm_notes ON crm_notes;
CREATE TRIGGER ks_webhook_crm_notes AFTER INSERT ON crm_notes FOR EACH ROW EXECUTE FUNCTION ks_webhook_capture();
