import { Router } from "express";
import { requireAuth, requireAuthorization } from "../middleware/auth.js";
import {
  fetchMe,
  updateMe,
  listUsers,
  adminUpdateUser,
  createUser,
  deleteUser,
} from "../services/users.service.js";
import adminUserRoutes from "../modules/users/users.routes.js";
import { pool as teamDb } from "../db.js";
import { importTeam, MAX_IMPORT, previewImport, sendInvites } from "../team/teamImport.js"; // KS_SERVER_TEAM_IMPORT_v1
import { ALL_ROLES, ROLES } from "../auth/roles.js";
import { safeHandler } from "../middleware/safeHandler.js"; // BF_SERVER_v789_SAFE_HANDLERS

const router = Router();

async function handleMe(req: any, res: any) {
  try {
    const user = await fetchMe(req);
    if (!user) {
      res.status(500).json({ error: "me_unavailable" });
      return;
    }
    res.json(user);
  } catch {
    res.status(500).json({ error: "me_unavailable" });
  }
}

async function handlePatchMe(req: any, res: any) {
  try {
    const user = await fetchMe(req);
    if (!user) {
      res.status(500).json({ error: "me_unavailable" });
      return;
    }
  } catch {
    res.status(500).json({ error: "me_unavailable" });
    return;
  }

  return updateMe(req, res);
}


/**
 * Self profile
 */
router.get("/me", requireAuth, requireAuthorization({ roles: ALL_ROLES }), handleMe);
router.patch(
  "/me",
  requireAuth,
  requireAuthorization({ roles: ALL_ROLES }),
  safeHandler(handlePatchMe) // BF_SERVER_v789_SAFE_HANDLERS
);

/**
 * Admin user management
 */
router.get(
  "/",
  requireAuth,
  requireAuthorization({ roles: [ROLES.ADMIN] }),
  safeHandler(listUsers) // BF_SERVER_v789_SAFE_HANDLERS
);
router.post(
  "/",
  requireAuth,
  requireAuthorization({ roles: [ROLES.ADMIN] }),
  createUser
);
// KS_SERVER_TEAM_IMPORT_v1 - POST /api/users/import { people: [{ name, email, phone, role }], invite?, preview? }
//   preview: what would happen to each row and the seats before/after, nothing created.
//   otherwise: creates the people (an existing person is never changed) and, with invite, emails them their invite.
// POST /api/users/invite { user_ids } - emails the invite to people added earlier (or sends it again).
router.post(
  "/import",
  requireAuth,
  requireAuthorization({ roles: [ROLES.ADMIN] }),
  async (req: any, res: any) => {
    try {
      const people = Array.isArray(req.body?.people) ? req.body.people : null;
      if (!people || !people.length) return res.status(400).json({ error: "people_required", message: "Add at least one person." });
      if (people.length > MAX_IMPORT) return res.status(400).json({ error: "too_many_people", message: `Import at most ${MAX_IMPORT} people at a time.` });
      if (req.body?.preview === true) return res.json({ ok: true, ...(await previewImport(teamDb as any, people)) });
      const r = await importTeam(teamDb as any, people, req.body?.invite === true);
      return res.json({ ok: true, ...r });
    } catch (err) {
      console.error("[team-import] import failed", err instanceof Error ? err.message : err);
      return res.status(500).json({ error: "import_failed", message: "The team could not be imported. Nothing was invited; try again." });
    }
  },
);
router.post(
  "/invite",
  requireAuth,
  requireAuthorization({ roles: [ROLES.ADMIN] }),
  async (req: any, res: any) => {
    try {
      const ids = Array.isArray(req.body?.user_ids) ? req.body.user_ids.map(String).slice(0, MAX_IMPORT) : [];
      if (!ids.length) return res.status(400).json({ error: "user_ids_required", message: "Choose who to invite." });
      const r = await sendInvites(teamDb as any, ids);
      if (!r.ok) return res.status(503).json({ error: r.error, message: "Invites can't be sent right now: this copy isn't linked to Keystone operations." });
      return res.json(r);
    } catch (err) {
      console.error("[team-import] invite failed", err instanceof Error ? err.message : err);
      return res.status(500).json({ error: "invite_failed", message: "The invites could not be sent. Try again." });
    }
  },
);

router.patch(
  "/:id",
  requireAuth,
  requireAuthorization({ roles: [ROLES.ADMIN] }),
  adminUpdateUser
);
router.delete(
  "/:id",
  requireAuth,
  requireAuthorization({ roles: [ROLES.ADMIN] }),
  deleteUser
);
router.use(
  "/",
  requireAuth,
  requireAuthorization({ roles: [ROLES.ADMIN] }),
  adminUserRoutes
);

export default router;
