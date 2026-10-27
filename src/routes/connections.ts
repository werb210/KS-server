// KS_SERVER_M365_ONE_CLICK - Settings > Connections (Admins).
//   GET /api/connections/status   Microsoft 365 and Google Workspace in plain English (?refresh=1 re-checks Microsoft)
// Connecting, the copyable admin link and disconnecting are under /api/o365-oauth/admin-consent/* (routes/o365OAuth.ts);
// the shared mailbox is saved with PUT /api/licensee { office365_send_as }.
import { Router } from "express";
import { pool } from "../db.js";
import { auth, requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { workspaceConnections } from "../licensee/workspaceConnections.js";

const router = Router();

router.get("/status", auth, requireAuthorization({ roles: [ROLES.ADMIN] }), safeHandler(async (req: any, res: any) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ ok: true, ...(await workspaceConnections(pool, { refresh: req.query.refresh === "1" })) });
}));

export default router;
