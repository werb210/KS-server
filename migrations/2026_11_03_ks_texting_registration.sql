-- KS_SERVER_TEXTING_REGISTRATION - texting registration status pushed by Keystone operations (KS-Ops
-- PUT /api/provision/texting): toll-free verification for the toll-free line and US A2P 10DLC for a US business line.
-- It decides where texts to US mobiles may go from (the brokerage's own approved toll-free line, or its registered
-- local line) and is shown on Settings > Phone lines in plain English. One row per kind. Safe to run again.
CREATE TABLE IF NOT EXISTS texting_registrations (
  kind text PRIMARY KEY CHECK (kind IN ('toll_free', 'a2p_10dlc')),
  status text NOT NULL CHECK (status IN ('needs_info', 'submitted', 'pending', 'approved', 'rejected', 'not_needed')),
  phone_number text,
  reason text,
  message text,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- The Twilio address (AD...) and regulatory bundle (BU...) KS-Ops registered in this copy's sub-account, used for every
-- number bought when TWILIO_ADDRESS_SID / TWILIO_BUNDLE_SID are not set on the App Service. One row.
CREATE TABLE IF NOT EXISTS twilio_compliance (
  id int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  address_sid text,
  bundle_sid text,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
