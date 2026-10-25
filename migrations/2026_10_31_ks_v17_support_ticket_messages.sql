-- KS_SERVER_v17_TICKET_FOLLOW_UPS - follow-up replies from the licensee's staff on a support ticket. Each one is stored
-- here and relayed to KS-Ops (POST /api/licensees/{id}/tickets/{ops_ticket_id}/messages). Safe to run again.
CREATE TABLE IF NOT EXISTS support_ticket_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  created_by text,
  body text NOT NULL,
  ops_message_id text,
  relayed_at timestamptz,
  relay_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS support_ticket_messages_ticket_idx ON support_ticket_messages (ticket_id, created_at);
