// BF_SERVER_BLOCK_v_NOTIF_PUSH_v1
import { pool } from "../../db.js";
import { sendNotification, type PushTarget } from "../pushService.js";
import { wants } from "../../notificationPrefs/prefs.js"; // KS_NOTIFICATION_TOPICS_v1

/** `topic` (KS_NOTIFICATION_TOPICS_v1): skipped when the person turned push off for that topic. */
export async function pushToUser(userId: string, title: string, body: string, data = "/", topic?: string): Promise<void> {
  if (!userId || !title) return;
  try {
    if (topic && !(await wants(userId, topic, "push"))) return;
    const r = await pool.query<{ role: string }>(`SELECT role FROM users WHERE id = $1 LIMIT 1`, [userId]);
    const role = r.rows[0]?.role ?? "STAFF";
    await sendNotification({ userId, role } as unknown as PushTarget, {
      type: "alert", title, body: body ?? "", level: "normal", sound: true, data,
    });
  } catch { /* best-effort */ }
}
