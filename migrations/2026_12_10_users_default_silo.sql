-- KS_SERVER_TEAM_LIST_v1 - people made at set-up (the owner and the sign-up team) had no silo, so they were missing from
-- Team and roles and silo-scoped lists. Keystone has one business, BF ("Lending"). Idempotent.
UPDATE users SET silo = 'BF' WHERE silo IS NULL;
UPDATE users SET silos = ARRAY['BF']::text[] WHERE silos IS NULL OR cardinality(silos) = 0;
