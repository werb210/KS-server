-- KS_META_LEAD_ADS_v1 - connected Facebook Pages, sign-in states, and every lead handled (so a retry is not a duplicate).
CREATE TABLE IF NOT EXISTS meta_lead_pages (
  page_id         text PRIMARY KEY,
  page_name       text NOT NULL,
  page_token_enc  text NOT NULL,
  active          boolean NOT NULL DEFAULT true,
  tag             text,
  leads           integer NOT NULL DEFAULT 0,
  last_lead_at    timestamptz,
  connected_by    uuid,
  connected_at    timestamptz NOT NULL DEFAULT now(),
  disconnected_at timestamptz
);
CREATE TABLE IF NOT EXISTS meta_oauth_states (
  nonce_hash  text PRIMARY KEY,
  user_id     uuid NOT NULL,
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE TABLE IF NOT EXISTS meta_leads (
  leadgen_id  text PRIMARY KEY,
  page_id     text NOT NULL,
  form_id     text,
  ad_id       text,
  contact_id  uuid,
  outcome     text,
  received_at timestamptz NOT NULL DEFAULT now(),
  handled_at  timestamptz
);
CREATE INDEX IF NOT EXISTS meta_leads_page ON meta_leads (page_id, received_at DESC);
