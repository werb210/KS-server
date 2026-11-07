-- KS_SERVER_NUMBER_PORTING_v1 - "Keep your existing phone number". A number the brokerage transferred (ported) into its
-- Twilio account is attached here when Keystone operations marks the transfer complete. It is the brokerage's own:
-- it never counts against the plan's line limits and a plan change never releases it. port_request_id is KS-Ops's id
-- for the transfer request. Safe to run again.
ALTER TABLE phone_numbers ADD COLUMN IF NOT EXISTS ported boolean NOT NULL DEFAULT false;
ALTER TABLE phone_numbers ADD COLUMN IF NOT EXISTS port_request_id text;
ALTER TABLE phone_numbers ADD COLUMN IF NOT EXISTS ported_at timestamptz;
