-- KS_SERVER_v15_BRAND_SYNC - the branding Keystone operations last pushed (PUT /api/plan { branding }): primary,
-- accent and background colours, font and logo chosen at sign-up. A field follows the pushed value until the
-- licensee's admin changes it on the Company page; from then on the admin's value wins. Safe to run again.
ALTER TABLE IF EXISTS licensee_settings ADD COLUMN IF NOT EXISTS ops_branding jsonb;
