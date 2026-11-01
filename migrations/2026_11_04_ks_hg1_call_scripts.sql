-- KS_HUBSPOT_GAPS_1_CALL_SCRIPTS - call scripts (playbooks), Growth and Pro.
--
-- Admins build scripts of sections (talking points and questions with answer fields). Staff open one beside the
-- dialler or on a contact / application; each filled-in script is a run. A finished run goes on the contact's
-- timeline, and answers to questions mapped to a custom field are written to that field.
-- Idempotent: safe to run on every start.

CREATE TABLE IF NOT EXISTS call_scripts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  use_for text NOT NULL DEFAULT 'any',
  sections jsonb NOT NULL DEFAULT '[]'::jsonb,
  position integer NOT NULL DEFAULT 0,
  archived_at timestamptz,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT call_scripts_use_for_check CHECK (use_for IN ('any', 'calls', 'contacts', 'applications'))
);
CREATE UNIQUE INDEX IF NOT EXISTS call_scripts_name_uidx ON call_scripts (lower(name)) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS call_script_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  script_id uuid NOT NULL REFERENCES call_scripts(id),
  script_name text NOT NULL,
  script_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  contact_id uuid,
  application_id text,
  call_sid text,
  answers jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'in_progress',
  field_updates jsonb NOT NULL DEFAULT '[]'::jsonb,
  field_errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT call_script_runs_status_check CHECK (status IN ('in_progress', 'completed'))
);
CREATE INDEX IF NOT EXISTS call_script_runs_contact_idx ON call_script_runs (contact_id, created_at DESC) WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS call_script_runs_application_idx ON call_script_runs (application_id, created_at DESC) WHERE application_id IS NOT NULL;
