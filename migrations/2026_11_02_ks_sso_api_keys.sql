-- KS_SERVER_SSO_API_KEYS - single sign-on for staff and API keys for the public REST API (both Pro). Safe to run again.

-- The brokerage's SSO choices (one row, id = 1). Nothing is on until an Admin turns a provider on.
CREATE TABLE IF NOT EXISTS sso_settings (
  id integer PRIMARY KEY DEFAULT 1,
  microsoft_enabled boolean NOT NULL DEFAULT false,
  google_enabled boolean NOT NULL DEFAULT false,
  -- Optional: only accept Microsoft accounts from this Entra tenant (GUID).
  microsoft_tenant_id text NOT NULL DEFAULT '',
  -- Optional: only accept Google accounts from this Workspace domain (the hd claim).
  google_hosted_domain text NOT NULL DEFAULT '',
  -- Staff (not Admins) must use SSO; text codes and passkeys stay open for Admins as break-glass.
  require_sso boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  CONSTRAINT sso_settings_single_row CHECK (id = 1)
);

-- Single-use sign-in state: sha256 of the state value, the PKCE verifier and the id_token nonce, 10-minute life.
CREATE TABLE IF NOT EXISTS sso_login_states (
  state_hash text PRIMARY KEY,
  provider text NOT NULL,
  code_verifier text NOT NULL,
  nonce text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sso_login_states_expires_idx ON sso_login_states (expires_at);

-- One-time hand-off from the SSO callback to the portal: sha256 of a 60-second code, exchanged once for a session.
CREATE TABLE IF NOT EXISTS sso_login_handoffs (
  code_hash text PRIMARY KEY,
  user_id text NOT NULL,
  provider text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sso_login_handoffs_expires_idx ON sso_login_handoffs (expires_at);

-- API keys. The key itself is shown once; only an HMAC-SHA256 of it is kept (pepper: KS_API_KEY_PEPPER, or the
-- server's JWT secret when that is unset - pepper_source records which, so setting the pepper later keeps old keys).
CREATE TABLE IF NOT EXISTS api_keys (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  scope text NOT NULL DEFAULT 'read',
  key_prefix text NOT NULL,
  key_hash text NOT NULL,
  pepper_source text NOT NULL DEFAULT 'env',
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoked_by text,
  CONSTRAINT api_keys_scope_check CHECK (scope IN ('read', 'read_write'))
);
CREATE INDEX IF NOT EXISTS api_keys_active_idx ON api_keys (created_at DESC) WHERE revoked_at IS NULL;
