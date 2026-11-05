-- KS_LANDING_PAGES_v1 - landing pages built from blocks, served at /api/public/pages/<slug>.
CREATE TABLE IF NOT EXISTS landing_pages (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  silo         text NOT NULL DEFAULT 'BF',
  slug         text NOT NULL,
  title        text NOT NULL,
  description  text,
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  blocks       jsonb NOT NULL DEFAULT '[]'::jsonb,
  views        integer NOT NULL DEFAULT 0,
  submissions  integer NOT NULL DEFAULT 0,
  created_by   uuid,
  published_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS landing_pages_slug ON landing_pages (slug);
CREATE INDEX IF NOT EXISTS landing_pages_silo ON landing_pages (silo, updated_at DESC);
