-- KS_SERVER_v12_DEMO_REAL_PACKAGE - the demo now builds the lender package with the real package builder: a zip (as
-- attached to the lender email) and the lender email rendered for it. Idempotent.
ALTER TABLE demo_applications ADD COLUMN IF NOT EXISTS package_zip bytea;
ALTER TABLE demo_applications ADD COLUMN IF NOT EXISTS package_mail jsonb;
