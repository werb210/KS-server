-- KS_SETTINGS_PACK_v1_BOOKING - public booking pages (one per staff member, plus the team round-robin page), meeting
-- types, a client's own cancel / reschedule link, and email / text reminders 24 hours and 1 hour before.
-- Idempotent: safe to run again.

CREATE TABLE IF NOT EXISTS booking_meeting_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL,
  name text NOT NULL,
  description text,
  duration_min integer NOT NULL DEFAULT 30 CHECK (duration_min BETWEEN 10 AND 240),
  kind text NOT NULL DEFAULT 'phone' CHECK (kind IN ('phone', 'video')),
  buffer_min integer NOT NULL DEFAULT 0 CHECK (buffer_min BETWEEN 0 AND 120),
  min_notice_min integer NOT NULL DEFAULT 120 CHECK (min_notice_min BETWEEN 0 AND 20160),
  max_days_ahead integer NOT NULL DEFAULT 14 CHECK (max_days_ahead BETWEEN 1 AND 90),
  active boolean NOT NULL DEFAULT true,
  sort integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS booking_meeting_types_slug_idx ON booking_meeting_types (slug);

ALTER TABLE client_bookings ADD COLUMN IF NOT EXISTS meeting_type_id uuid;
ALTER TABLE client_bookings ADD COLUMN IF NOT EXISTS manage_token_hash text;
ALTER TABLE client_bookings ADD COLUMN IF NOT EXISTS sms_reminders boolean NOT NULL DEFAULT false;
ALTER TABLE client_bookings ADD COLUMN IF NOT EXISTS confirmation_sent_at timestamptz;
ALTER TABLE client_bookings ADD COLUMN IF NOT EXISTS reminder_24h_at timestamptz;
ALTER TABLE client_bookings ADD COLUMN IF NOT EXISTS reminder_1h_at timestamptz;
ALTER TABLE client_bookings ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
ALTER TABLE client_bookings ADD COLUMN IF NOT EXISTS rescheduled_to uuid;
CREATE UNIQUE INDEX IF NOT EXISTS client_bookings_manage_token_idx ON client_bookings (manage_token_hash) WHERE manage_token_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS client_bookings_reminders_idx ON client_bookings (starts_at) WHERE status = 'booked';
