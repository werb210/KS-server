-- KS_HUBSPOT_GAPS_1_MEETING_NOTES - Zoom and Google Meet meeting notes, like the Teams transcripts (every plan with
-- office sync).
--
-- Zoom: each staff member connects their own Zoom (OAuth, user-level); cloud-recording transcripts are pulled in.
-- Google Meet: through the existing Google connection, conference transcripts are read with the Meet API.
-- Both land in teams_meetings (now any provider) so the existing AI summary, follow-up tasks and the contact timeline
-- work unchanged. Idempotent: safe to run on every start.

ALTER TABLE teams_meetings ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'teams';
ALTER TABLE teams_meetings ADD COLUMN IF NOT EXISTS external_id text;
ALTER TABLE teams_meetings ADD COLUMN IF NOT EXISTS match_method text;
CREATE UNIQUE INDEX IF NOT EXISTS teams_meetings_provider_external_uidx ON teams_meetings (provider, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS teams_meetings_organizer_provider_idx ON teams_meetings (organizer_user_id, provider, created_at DESC);

CREATE TABLE IF NOT EXISTS zoom_accounts (
  user_id uuid PRIMARY KEY,
  zoom_user_id text,
  zoom_email text,
  access_token_enc text,
  refresh_token_enc text,
  access_token_expires_at timestamptz,
  scopes text,
  status text NOT NULL DEFAULT 'connected',
  last_synced_at timestamptz,
  last_error text,
  connected_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS zoom_oauth_states (
  state_hash text PRIMARY KEY,
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS google_meet_sync (
  user_id uuid PRIMARY KEY,
  last_synced_at timestamptz,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
