-- KS_SERVER_BRAND_ASSETS_v1 - the brokerage's own favicon (browser tab icon), next to its logo. Safe to run again.
ALTER TABLE licensee_settings ADD COLUMN IF NOT EXISTS favicon_url text;
