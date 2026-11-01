-- KS_SERVER_v23_FORECAST - revenue (commission) forecasting from the pipeline.
-- The chance each lending stage funds (Admin-editable, percent), and on each application the expected close date and
-- an optional forecast category that overrides the one the stage implies.
CREATE TABLE IF NOT EXISTS forecast_stage_probabilities (
  stage text PRIMARY KEY,
  probability integer NOT NULL CHECK (probability BETWEEN 0 AND 100),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);
-- The odds the Revenue forecast report always used (src/services/reports/data2.ts STAGE_ODDS).
INSERT INTO forecast_stage_probabilities (stage, probability) VALUES
  ('Received', 10), ('In Review', 25), ('Documents Required', 15), ('Additional Steps Required', 15),
  ('Off to Lender', 40), ('Offer', 70), ('Accepted', 85)
ON CONFLICT (stage) DO NOTHING;

ALTER TABLE applications ADD COLUMN IF NOT EXISTS expected_close_date date;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS forecast_category text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'applications_forecast_category_check') THEN
    ALTER TABLE applications ADD CONSTRAINT applications_forecast_category_check
      CHECK (forecast_category IS NULL OR forecast_category IN ('pipeline', 'best_case', 'commit', 'omit'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS applications_expected_close_idx ON applications (expected_close_date) WHERE expected_close_date IS NOT NULL;
