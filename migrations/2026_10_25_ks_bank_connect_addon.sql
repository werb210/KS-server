-- KS_SERVER_BANK_CONNECT_ADDON - per-licensee add-ons set by Keystone operations (PUT /api/plan { addons }).
-- Not plan features. { "bank_connect": true } switches on the Connect Bank (View-Only) step, the staff request item,
-- fraud check 3 and the Flinks provider for this copy. Default: nothing on. Safe to run again.
ALTER TABLE licensee_plan ADD COLUMN IF NOT EXISTS addons jsonb NOT NULL DEFAULT '{}'::jsonb;
