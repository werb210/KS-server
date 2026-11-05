// KS_NOTIFICATION_TOPICS_v1 - reading and saving each person's notification settings.
// A row exists only for a topic someone changed; no row means every channel is on.
import { pool } from "../db.js";
import { CHANNELS, TOPICS, isLocked, topicByKey, type Channel } from "./topics.js";

type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

export type TopicSetting = { topic: string; bell: boolean; push: boolean; text: boolean };

const COLUMN: Record<Channel, string> = { bell: "bell", push: "push", text: "text_message" };

/** The settings for one person, one entry per topic (defaults filled in). */
export async function settingsFor(userId: string, db: Q = pool as unknown as Q): Promise<TopicSetting[]> {
  const { rows } = await db.query(
    `SELECT topic, bell, push, text_message FROM notification_preferences WHERE user_id = $1::uuid`,
    [userId],
  );
  const saved = new Map(rows.map((r: any) => [String(r.topic), r]));
  return TOPICS.map((t) => {
    const r = saved.get(t.key);
    return {
      topic: t.key,
      bell: isLocked(t.key, "bell") ? true : r ? r.bell !== false : true,
      push: isLocked(t.key, "push") ? true : r ? r.push !== false : true,
      text: isLocked(t.key, "text") ? true : r ? r.text_message !== false : true,
    };
  });
}

/** Topics this person has turned off for one channel. */
export async function mutedTopics(userId: string, channel: Channel, db: Q = pool as unknown as Q): Promise<string[]> {
  const { rows } = await db.query(
    `SELECT topic FROM notification_preferences WHERE user_id = $1::uuid AND ${COLUMN[channel]} = false`,
    [userId],
  );
  return rows.map((r: any) => String(r.topic)).filter((t) => topicByKey(t) && !isLocked(t, channel));
}

/** Of these people, the ones who turned this topic off for this channel. One query for a whole fan-out. */
export async function usersWhoMuted(
  userIds: readonly string[], topic: string, channel: Channel, db: Q = pool as unknown as Q,
): Promise<Set<string>> {
  if (!userIds.length || topic === "other" || isLocked(topic, channel) || !topicByKey(topic)) return new Set();
  const { rows } = await db.query(
    `SELECT user_id::text AS user_id FROM notification_preferences
      WHERE user_id::text = ANY($1::text[]) AND topic = $2 AND ${COLUMN[channel]} = false`,
    [userIds, topic],
  );
  return new Set(rows.map((r: any) => String(r.user_id)));
}

/** True when this person wants this topic on this channel. Errors count as "yes" so nothing is lost. */
export async function wants(userId: string, topic: string, channel: Channel, db: Q = pool as unknown as Q): Promise<boolean> {
  try {
    return !(await usersWhoMuted([userId], topic, channel, db)).has(userId);
  } catch (err) {
    console.warn(JSON.stringify({ event: "notification_prefs_lookup_failed", topic, channel, error: String((err as Error)?.message ?? err).slice(0, 200) }));
    return true;
  }
}

/** Saves the changed topics. Locked channels and unknown topics are ignored. */
export async function saveSettings(userId: string, input: unknown, db: Q = pool as unknown as Q): Promise<TopicSetting[]> {
  const list = Array.isArray(input) ? input : [];
  for (const item of list) {
    const topic = typeof item?.topic === "string" ? item.topic : "";
    if (!topicByKey(topic)) continue;
    const v: Record<Channel, boolean> = { bell: true, push: true, text: true };
    for (const c of CHANNELS) v[c] = isLocked(topic, c) ? true : item?.[c] !== false;
    await db.query(
      `INSERT INTO notification_preferences (user_id, topic, bell, push, text_message, updated_at)
       VALUES ($1::uuid, $2, $3, $4, $5, now())
       ON CONFLICT (user_id, topic) DO UPDATE
         SET bell = EXCLUDED.bell, push = EXCLUDED.push, text_message = EXCLUDED.text_message, updated_at = now()`,
      [userId, topic, v.bell, v.push, v.text],
    );
  }
  return settingsFor(userId, db);
}
