-- KS_SERVER_BETA_v1 - beta features set by Keystone operations (KS-Ops pushes PUT /api/plan { beta_features }).
-- beta_features is this licensee's full view of the beta catalogue: [{ key, name, description, status, enabled,
-- enrolled, can_join, can_leave, feedback_url, docs_url }]. isEnabled(key) reads it. Default: nothing on.
-- Safe to run again.
ALTER TABLE licensee_plan ADD COLUMN IF NOT EXISTS beta_features jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE licensee_plan ADD COLUMN IF NOT EXISTS beta_features_synced_at timestamptz;
