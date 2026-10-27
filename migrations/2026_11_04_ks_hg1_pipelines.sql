-- KS_HUBSPOT_GAPS_1_PIPELINES - extra pipelines with their own stages (Growth: 3 pipelines in all, Pro: unlimited).
--
-- The lending pipeline is not a row here: it keeps applications.pipeline_state, its locked system stages and every
-- existing behaviour. An application in an extra pipeline has pipeline_id / pipeline_stage_id set and leaves the
-- lending board (its pipeline_state is kept, so moving it back puts it where it was).
-- Idempotent: safe to run on every start.

CREATE TABLE IF NOT EXISTS pipelines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  position integer NOT NULL DEFAULT 0,
  archived_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS pipelines_name_uidx ON pipelines (lower(name)) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS pipeline_stages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id uuid NOT NULL REFERENCES pipelines(id),
  name text NOT NULL,
  position integer NOT NULL DEFAULT 0,
  color text NOT NULL DEFAULT '#1d4ed8',
  probability integer NOT NULL DEFAULT 0,
  outcome text NOT NULL DEFAULT 'open',
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pipeline_stages_probability_check CHECK (probability BETWEEN 0 AND 100),
  CONSTRAINT pipeline_stages_outcome_check CHECK (outcome IN ('open', 'won', 'lost'))
);
CREATE INDEX IF NOT EXISTS pipeline_stages_pipeline_idx ON pipeline_stages (pipeline_id, position);

ALTER TABLE applications ADD COLUMN IF NOT EXISTS pipeline_id uuid;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS pipeline_stage_id uuid;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS pipeline_stage_entered_at timestamptz;
CREATE INDEX IF NOT EXISTS applications_pipeline_idx ON applications (pipeline_id, pipeline_stage_id) WHERE pipeline_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS pipeline_moves (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id text NOT NULL,
  from_pipeline_id uuid,
  from_stage text,
  to_pipeline_id uuid,
  to_stage text,
  moved_by uuid,
  moved_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pipeline_moves_application_idx ON pipeline_moves (application_id, moved_at DESC);
