-- KS_SETUP_WIZARD - the in-app set-up wizard: what each person has marked done or skipped by hand.
-- Most steps are detected from existing data (logo saved, phone number bought, lender added ...); this table only
-- holds the manual answers, plus one row per person with step_key '_wizard' when they close the wizard for good.
-- Idempotent: safe to run again.
CREATE TABLE IF NOT EXISTS setup_progress (
  user_id uuid NOT NULL,
  step_key text NOT NULL,
  status text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, step_key)
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'setup_progress_status_check') THEN
    ALTER TABLE setup_progress ADD CONSTRAINT setup_progress_status_check CHECK (status IN ('done', 'skipped'));
  END IF;
END $$;
