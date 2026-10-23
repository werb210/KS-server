// KS_SERVER_v12_GOOGLE_WORKSPACE - portal tasks <-> Google Tasks, for staff on Google Workspace.
// The Google twin of todoReconcileWorker.ts (Microsoft To Do). It only handles assignees who have NO Microsoft 365
// sign-in, so nobody gets the same task in both apps. Every 5 minutes, and right after a task is saved:
//   1. Push: open tasks never sent (google_task_id and google_synced_at both NULL) are created; tasks changed since
//      their last sync (updated_at > google_synced_at) are updated, completed or deleted in Google Tasks.
//   2. Pull: tasks ticked off in Google Tasks complete the matching open portal task.
// google_synced_at = updated_at after each sync, so a pull never echoes back as a push.
import type { Pool } from "pg";
import { logWarnSwallowed } from "../lib/logWarnSwallowed.js";
import { claimedTick } from "./claim.js";
import { getGoogleForUser, type GoogleClient } from "../services/workspace/googleAuth.js";
import { googleConfigProblem } from "../services/workspace/googleConfig.js";
import { GoogleApiError, completedGoogleTaskIds, createGoogleTask, deleteGoogleTask, updateGoogleTask } from "../services/workspace/google.js";
import { todoTitle } from "./todoReconcileWorker.js";

const TICK_MS = 5 * 60 * 1000;
const MAX_USERS_PER_TICK = 50;
const MAX_TASKS_PER_USER = 100;

type PendingTask = {
  id: string; title: string; body: string | null; status: string; due_at: string | Date | null;
  deleted_at: string | Date | null; google_task_id: string | null; contact_name: string | null;
};

async function markSynced(pool: Pool, id: string, googleId: string | null): Promise<void> {
  await pool.query(`UPDATE tasks SET google_task_id = $2, google_synced_at = updated_at WHERE id = $1`, [id, googleId]);
}

const inputOf = (t: PendingTask) => ({ title: todoTitle(t), notes: t.body, due: t.due_at, completed: t.status === "COMPLETED" });

export async function pushGoogleUser(pool: Pool, g: GoogleClient, userId: string, onlyTaskId: string | null = null): Promise<number> {
  const pending = await pool.query<PendingTask>(
    `SELECT t.id, t.title, t.body, t.status, t.due_at, t.deleted_at, t.google_task_id,
            NULLIF(TRIM(COALESCE(NULLIF(c.name, ''), CONCAT_WS(' ', c.first_name, c.last_name))), '') AS contact_name
       FROM tasks t
       LEFT JOIN contacts c ON c.id = t.contact_id
      WHERE t.assignee_user_id = $1
        AND ((t.google_task_id IS NULL AND t.google_synced_at IS NULL AND t.deleted_at IS NULL AND t.status <> 'COMPLETED')
          OR (t.google_task_id IS NOT NULL AND (t.google_synced_at IS NULL OR t.updated_at > t.google_synced_at)))
        AND ($3::uuid IS NULL OR t.id = $3::uuid)
      ORDER BY t.updated_at ASC
      LIMIT $2`,
    [userId, MAX_TASKS_PER_USER, onlyTaskId],
  );
  let done = 0;
  for (const t of pending.rows) {
    try {
      if (t.deleted_at) {
        if (t.google_task_id) await deleteGoogleTask(g, t.google_task_id);
        await markSynced(pool, t.id, null);
      } else if (t.google_task_id) {
        try {
          await updateGoogleTask(g, t.google_task_id, inputOf(t));
          await markSynced(pool, t.id, t.google_task_id);
        } catch (err) {
          // Deleted in Google Tasks: leave the portal task alone and stop syncing it.
          if (err instanceof GoogleApiError && (err.status === 404 || err.status === 410)) await markSynced(pool, t.id, null);
          else throw err;
        }
      } else {
        await markSynced(pool, t.id, await createGoogleTask(g, inputOf(t)));
      }
      done++;
    } catch (err) {
      console.warn("[google-tasks] task push failed", { taskId: t.id, error: err instanceof Error ? err.message : String(err) });
      if (err instanceof GoogleApiError && (err.status === 401 || err.status === 403 || err.status === 429)) break;
    }
  }
  return done;
}

export async function pullGoogleUser(pool: Pool, g: GoogleClient, userId: string): Promise<number> {
  const open = await pool.query<{ id: string; google_task_id: string }>(
    `SELECT id, google_task_id FROM tasks
      WHERE assignee_user_id = $1 AND google_task_id IS NOT NULL AND deleted_at IS NULL AND status <> 'COMPLETED'`,
    [userId],
  );
  if (!open.rows.length) return 0;
  const byGoogle = new Map(open.rows.map((r) => [r.google_task_id, r.id]));
  const completed = (await completedGoogleTaskIds(g)).map((gid) => byGoogle.get(gid)).filter((x): x is string => Boolean(x));
  if (!completed.length) return 0;
  await pool.query(
    `UPDATE tasks SET status = 'COMPLETED', completed_at = now(), updated_at = now(), google_synced_at = now()
      WHERE id = ANY($1::uuid[]) AND status <> 'COMPLETED'`,
    [completed],
  );
  return completed.length;
}

/** The assignee's Google client when they are on Google only (no Microsoft sign-in). */
async function googleOnlyClient(pool: Pool, userId: string): Promise<GoogleClient | null> {
  const r = await pool.query<{ has_o365: boolean }>(
    `SELECT (o365_access_token IS NOT NULL OR o365_refresh_token IS NOT NULL) AS has_o365 FROM users WHERE id = $1`,
    [userId],
  );
  if (!r.rows[0] || r.rows[0].has_o365) return null;
  return getGoogleForUser(pool, userId);
}

export async function reconcileGoogleTasksOnce(pool: Pool): Promise<{ users: number; pushed: number; pulled: number }> {
  if (googleConfigProblem()) return { users: 0, pushed: 0, pulled: 0 };
  const users = await pool.query<{ user_id: string }>(
    `SELECT DISTINCT t.assignee_user_id::text AS user_id
       FROM tasks t
       JOIN google_workspace_accounts g ON g.user_id = t.assignee_user_id AND g.status = 'connected'
       JOIN users u ON u.id = t.assignee_user_id
      WHERE u.o365_access_token IS NULL AND u.o365_refresh_token IS NULL
        AND (t.google_task_id IS NOT NULL OR (t.google_synced_at IS NULL AND t.deleted_at IS NULL AND t.status <> 'COMPLETED'))
      LIMIT $1`,
    [MAX_USERS_PER_TICK],
  );
  let pushed = 0, pulled = 0;
  for (const { user_id } of users.rows) {
    try {
      const g = await getGoogleForUser(pool, user_id);
      if (!g) continue;
      pushed += await pushGoogleUser(pool, g, user_id);
      pulled += await pullGoogleUser(pool, g, user_id);
    } catch (err) {
      console.warn("[google-tasks] sync failed", { userId: user_id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (pushed || pulled) console.log("[google-tasks] synced", { users: users.rows.length, pushed, pulled });
  return { users: users.rows.length, pushed, pulled };
}

/** Sync one task right away (after the portal saves it). Never throws. */
export async function syncGoogleTaskNow(pool: Pool, taskId: string): Promise<void> {
  try {
    if (googleConfigProblem()) return;
    const r = await pool.query<{ assignee_user_id: string | null }>(`SELECT assignee_user_id::text AS assignee_user_id FROM tasks WHERE id::text = $1`, [taskId]);
    const userId = r.rows[0]?.assignee_user_id;
    if (!userId) return;
    const g = await googleOnlyClient(pool, userId);
    if (g) await pushGoogleUser(pool, g, userId, taskId);
  } catch (err) {
    console.warn("[google-tasks] immediate sync failed", { taskId, error: err instanceof Error ? err.message : String(err) });
  }
}

export function startGoogleTasksWorker(pool: Pool): { stop: () => void } {
  let running = false;
  const tickUnclaimed = async () => {
    if (running) return;
    running = true;
    try { await reconcileGoogleTasksOnce(pool); }
    catch (err) { logWarnSwallowed(err, "workers/googleTasksWorker.ts:tick"); }
    finally { running = false; }
  };
  const tick = claimedTick("google_tasks", tickUnclaimed);
  const first = setTimeout(() => void tick(), 90 * 1000);
  const timer = setInterval(() => void tick(), TICK_MS);
  return { stop: () => { clearTimeout(first); clearInterval(timer); } };
}
