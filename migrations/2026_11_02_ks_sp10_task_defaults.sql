-- KS_SETTINGS_PACK_v1_TASK_DEFAULTS - each person's follow-up task defaults: whether to be asked to create a follow-up
-- after a call, an email or a meeting, and the due time, type and reminder it starts with. Idempotent.
CREATE TABLE IF NOT EXISTS user_task_defaults (
  user_id uuid PRIMARY KEY,
  prompt_after_call boolean NOT NULL DEFAULT true,
  prompt_after_email boolean NOT NULL DEFAULT true,
  prompt_after_meeting boolean NOT NULL DEFAULT true,
  due_in_days integer NOT NULL DEFAULT 1 CHECK (due_in_days BETWEEN 0 AND 60),
  due_time text NOT NULL DEFAULT '09:00',
  task_type text NOT NULL DEFAULT 'CALL' CHECK (task_type IN ('CALL', 'EMAIL', 'SMS', 'TODO')),
  reminder_minutes integer CHECK (reminder_minutes IS NULL OR reminder_minutes BETWEEN 0 AND 10080),
  updated_at timestamptz NOT NULL DEFAULT now()
);
