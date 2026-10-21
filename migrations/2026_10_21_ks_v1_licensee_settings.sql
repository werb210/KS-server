-- KS_SERVER_v1_LICENSEE - this copy's company details and branding (one row). Safe to run again.
CREATE TABLE IF NOT EXISTS licensee_settings (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  company_name text,
  legal_name text,
  assistant_name text,
  support_email text,
  support_phone text,
  logo_url text,
  primary_color text,
  accent_color text,
  time_zone text,
  country text,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
