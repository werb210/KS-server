-- KS_SERVER_MARKETING_UNSUBSCRIBE - a contact who unsubscribes (marketing_opt_out) stops being a marketing contact,
-- whichever way the unsubscribe arrived (email link, the email provider, a call outcome, a privacy request): the
-- trigger below covers every path, and an unsubscribed contact cannot be marked a marketing contact again.
-- Safe to run again.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS marketing_contact boolean NOT NULL DEFAULT true;
CREATE INDEX IF NOT EXISTS contacts_marketing_contact_idx ON contacts (silo) WHERE marketing_contact = false;

CREATE OR REPLACE FUNCTION bf_unsubscribed_not_marketing() RETURNS trigger AS $$
BEGIN
  IF COALESCE(NEW.marketing_opt_out, false) THEN
    NEW.marketing_contact := false;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS contacts_unsubscribed_not_marketing ON contacts;
CREATE TRIGGER contacts_unsubscribed_not_marketing
  BEFORE INSERT OR UPDATE OF marketing_opt_out, marketing_contact ON contacts
  FOR EACH ROW EXECUTE FUNCTION bf_unsubscribed_not_marketing();

UPDATE contacts SET marketing_contact = false WHERE COALESCE(marketing_opt_out, false) = true AND marketing_contact = true;
