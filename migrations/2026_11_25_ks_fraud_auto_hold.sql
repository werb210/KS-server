-- KS_SERVER_FRAUD_AUTO_HOLD_v1 - a file moved to Fraud is kept as evidence: a legal hold is placed automatically
-- ("Fraud - automatic") and every active Admin gets a notification. A database trigger, so it holds however the file
-- reached Fraud (the board, the fraud checks, an automation or the API). Moving the file out of Fraud does NOT release
-- the hold; only an Admin can, under Privacy and records. Safe to run again.
CREATE OR REPLACE FUNCTION ks_fraud_auto_hold() RETURNS trigger AS $$
DECLARE
  inserted int;
BEGIN
  IF NEW.pipeline_state = 'Fraud' AND (TG_OP = 'INSERT' OR OLD.pipeline_state IS DISTINCT FROM NEW.pipeline_state) THEN
    INSERT INTO legal_holds (target_type, target_id, target_label, reason, placed_by_name)
    SELECT 'application', NEW.id::text, COALESCE(NULLIF(NEW.name, ''), NEW.id::text),
           'Fraud - automatic: the file was moved to the Fraud stage', 'Keystone (automatic)'
     WHERE NOT EXISTS (
       SELECT 1 FROM legal_holds h WHERE h.target_type = 'application' AND h.target_id = NEW.id::text AND h.released_at IS NULL
     );
    GET DIAGNOSTICS inserted = ROW_COUNT;
    IF inserted > 0 THEN
      BEGIN
      INSERT INTO notifications (user_id, application_id, type, title, body, ref_table, ref_id, context_url)
      SELECT u.id, NEW.id::text, 'fraud_legal_hold', 'Legal hold placed',
             COALESCE(NULLIF(NEW.name, ''), 'An application') || ' was moved to Fraud, so a legal hold was placed on it. Only an Admin can release it.',
             'applications', NEW.id::text, '/applications/' || NEW.id::text
        FROM users u
       WHERE u.active = true AND upper(coalesce(u.role, '')) = 'ADMIN'
      ON CONFLICT DO NOTHING;
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'ks_fraud_auto_hold: admin notification failed: %', SQLERRM; -- the hold itself still stands
      END;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ks_fraud_auto_hold_trg ON applications;
CREATE TRIGGER ks_fraud_auto_hold_trg
  AFTER INSERT OR UPDATE OF pipeline_state ON applications
  FOR EACH ROW EXECUTE FUNCTION ks_fraud_auto_hold();
