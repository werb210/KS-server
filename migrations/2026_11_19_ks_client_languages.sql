-- KS_CLIENT_LANGUAGES_v1 - the languages a brokerage offers its clients ("en,fr,es"), and each client's choice.
ALTER TABLE IF EXISTS licensee_settings ADD COLUMN IF NOT EXISTS client_languages text;
ALTER TABLE IF EXISTS contacts ADD COLUMN IF NOT EXISTS preferred_language text;
