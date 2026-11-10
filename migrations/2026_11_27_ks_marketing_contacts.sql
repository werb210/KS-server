-- KS_SERVER_MARKETING_CONTACTS_v1 - "Marketing contact" yes/no on every contact. Campaign emails, campaign texts,
-- sequence emails/texts and automation marketing texts go only to marketing contacts, so a brokerage can keep
-- thousands of contacts in the CRM and still stay inside its monthly campaign email allowance.
-- Everyone already in the CRM (and anyone added by hand, a form, an application or a lead ad) is a marketing contact
-- (the default). Contacts brought in by an import are NOT, unless the import says so. Safe to run again.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS marketing_contact boolean NOT NULL DEFAULT true;
CREATE INDEX IF NOT EXISTS contacts_marketing_contact_idx ON contacts (silo) WHERE marketing_contact = false;
