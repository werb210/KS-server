-- KS_SERVER_v14_BRAND_FONT - the licensee's background colour and font, next to primary_color and accent_color, so the
-- client app and the public pages use the licensee's own colours and font. Safe to run again.
ALTER TABLE IF EXISTS licensee_settings ADD COLUMN IF NOT EXISTS background_color text;
ALTER TABLE IF EXISTS licensee_settings ADD COLUMN IF NOT EXISTS font_family text;
