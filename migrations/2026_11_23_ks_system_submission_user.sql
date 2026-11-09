-- KS_SERVER_SYSTEM_SUBMISSION_USER_v1 - the client-submission system user (00000000-...-0001) owns draft applications
-- until staff pick them up. Migrations 107/110 create it, but a brand-new brokerage database loads the baseline snapshot
-- instead of replaying those, so the user was missing and every client's first "start application" failed with a
-- foreign-key error ("Constraint violation"). Inactive, no password, no sign-in. Safe to run again.
INSERT INTO users (id, email, role, active)
VALUES ('00000000-0000-0000-0000-000000000001', 'client-submission@system.local', 'Referrer', false)
ON CONFLICT DO NOTHING;
