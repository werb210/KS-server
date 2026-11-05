-- KS_EMAIL_SUBSCRIPTION_TYPES_v1 - marketing email types, and who opted out of which.
CREATE TABLE IF NOT EXISTS email_subscription_types (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  silo        text NOT NULL DEFAULT 'BF',
  key         text NOT NULL,
  name        text NOT NULL,
  description text,
  active      boolean NOT NULL DEFAULT true,
  sort_order  integer NOT NULL DEFAULT 100,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS email_subscription_types_silo_key ON email_subscription_types (silo, key);

CREATE TABLE IF NOT EXISTS contact_subscription_optouts (
  contact_id    uuid NOT NULL,
  type_id       uuid NOT NULL REFERENCES email_subscription_types(id) ON DELETE CASCADE,
  source        text NOT NULL DEFAULT 'preferences_page',
  opted_out_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (contact_id, type_id)
);
CREATE INDEX IF NOT EXISTS contact_subscription_optouts_type ON contact_subscription_optouts (type_id);

INSERT INTO email_subscription_types (silo, key, name, description, sort_order) VALUES
  ('BF', 'newsletter', 'Newsletter', 'News and tips about business financing.', 10),
  ('BF', 'offers', 'Offers and product updates', 'New lending products, rates and offers.', 20),
  ('BF', 'events', 'Events and webinars', 'Invitations to events and webinars.', 30)
ON CONFLICT (silo, key) DO NOTHING;
