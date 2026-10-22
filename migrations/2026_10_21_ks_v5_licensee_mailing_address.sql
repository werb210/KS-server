-- KS_SERVER_v5_MAILING_ADDRESS - the licensee's mailing address (CASL: shown in marketing emails and agreements).
-- Safe to run again.
ALTER TABLE IF EXISTS licensee_settings ADD COLUMN IF NOT EXISTS mailing_address text;
