-- KS_SERVER_CUSTOM_ROLES - custom roles built from a permission matrix (Pro). Safe to run again.
--
-- A custom role starts from a built-in role (base_role) and can only take permissions away from it. People keep
-- users.role = the base role, so every existing role check treats them as before; users.custom_role_id adds the
-- matrix on top (src/roles/enforce.ts). Nobody gets a custom role from this migration: every existing user keeps
-- custom_role_id NULL, which means exactly the access they had.
CREATE TABLE IF NOT EXISTS custom_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  base_role text NOT NULL DEFAULT 'Staff',
  -- { "contacts": { "view": true, "create": true, ... }, ... } (src/roles/permissions.ts)
  permissions jsonb NOT NULL DEFAULT '{}'::jsonb,
  record_visibility text NOT NULL DEFAULT 'all',
  created_by uuid,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  CONSTRAINT custom_roles_base_role_check CHECK (base_role IN ('Admin', 'Ops', 'Staff', 'Marketing')),
  CONSTRAINT custom_roles_record_visibility_check CHECK (record_visibility IN ('all', 'team', 'own'))
);
CREATE UNIQUE INDEX IF NOT EXISTS custom_roles_name_uidx ON custom_roles (lower(name)) WHERE archived_at IS NULL;

ALTER TABLE users ADD COLUMN IF NOT EXISTS custom_role_id uuid;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_custom_role_id_fkey') THEN
    ALTER TABLE users ADD CONSTRAINT users_custom_role_id_fkey
      FOREIGN KEY (custom_role_id) REFERENCES custom_roles(id) ON DELETE SET NULL;
  END IF;
END
$$;
CREATE INDEX IF NOT EXISTS users_custom_role_idx ON users (custom_role_id) WHERE custom_role_id IS NOT NULL;
