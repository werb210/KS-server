-- KS_NOTIFICATION_TOPICS_v1 - notification settings per topic. A row exists only for a topic the person changed.
CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id      uuid NOT NULL,
  topic        text NOT NULL,
  bell         boolean NOT NULL DEFAULT true,
  push         boolean NOT NULL DEFAULT true,
  text_message boolean NOT NULL DEFAULT true,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, topic)
);
CREATE INDEX IF NOT EXISTS notification_preferences_topic_idx ON notification_preferences (topic);
