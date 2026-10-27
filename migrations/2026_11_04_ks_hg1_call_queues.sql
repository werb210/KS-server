-- KS_HUBSPOT_GAPS_1_CALL_QUEUES - call queues for the main line and phone-menu options (Pro: call_queues).
--
-- Callers wait in a Twilio <Enqueue> queue with hold music, messages and their place in line. Keystone offers each
-- caller, oldest first, to the member who has been free the longest (available, signed in, not on a call, inside
-- their call hours); an unanswered offer goes to the next person. After the queue's longest wait the caller leaves a
-- voicemail or asks for a callback. call_queue_calls is the live list and the history.
-- Idempotent: safe to run on every start.

CREATE TABLE IF NOT EXISTS call_queues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  greeting text NOT NULL DEFAULT '',
  hold_message text NOT NULL DEFAULT '',
  hold_audio_id text,
  announce_position boolean NOT NULL DEFAULT true,
  max_wait_seconds integer NOT NULL DEFAULT 300,
  ring_seconds integer NOT NULL DEFAULT 20,
  overflow text NOT NULL DEFAULT 'voicemail',
  overflow_user_id uuid,
  archived_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT call_queues_overflow_check CHECK (overflow IN ('voicemail', 'callback', 'ask')),
  CONSTRAINT call_queues_wait_check CHECK (max_wait_seconds BETWEEN 30 AND 3600),
  CONSTRAINT call_queues_ring_check CHECK (ring_seconds BETWEEN 10 AND 60)
);
CREATE UNIQUE INDEX IF NOT EXISTS call_queues_name_uidx ON call_queues (lower(name)) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS call_queue_members (
  queue_id uuid NOT NULL REFERENCES call_queues(id),
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (queue_id, user_id)
);

-- One row per person who takes queue calls: their "available for queue calls" switch and when they were last free.
CREATE TABLE IF NOT EXISTS call_queue_agents (
  user_id uuid PRIMARY KEY,
  available boolean NOT NULL DEFAULT false,
  available_since timestamptz,
  last_call_ended_at timestamptz,
  last_missed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS call_queue_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  queue_id uuid NOT NULL REFERENCES call_queues(id),
  call_sid text NOT NULL,
  from_number text,
  caller_name text,
  contact_id uuid,
  status text NOT NULL DEFAULT 'waiting',
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  twilio_queue_sid text,
  position integer,
  wait_visits integer NOT NULL DEFAULT 0,
  offered_user_id uuid,
  offer_call_sid text,
  offered_at timestamptz,
  offer_attempts integer NOT NULL DEFAULT 0,
  skipped_user_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  answered_user_id uuid,
  answered_at timestamptz,
  ended_at timestamptz,
  wait_seconds integer,
  outcome text,
  callback_done_at timestamptz,
  callback_done_by uuid,
  CONSTRAINT call_queue_calls_status_check CHECK (status IN ('waiting', 'offered', 'connected', 'completed', 'abandoned', 'voicemail', 'callback'))
);
CREATE UNIQUE INDEX IF NOT EXISTS call_queue_calls_sid_uidx ON call_queue_calls (call_sid);
CREATE INDEX IF NOT EXISTS call_queue_calls_live_idx ON call_queue_calls (queue_id, enqueued_at) WHERE status IN ('waiting', 'offered', 'connected');
CREATE INDEX IF NOT EXISTS call_queue_calls_day_idx ON call_queue_calls (enqueued_at);
