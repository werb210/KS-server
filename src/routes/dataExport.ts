// KS_SERVER_v8_DATA_EXPORT - GET /api/export (Admin): a zip of all of this copy's data and uploaded documents
// (src/plans/dataExport.ts). Open to admins while the service is cancelled, so they can take their data with them.
import { Router } from "express";
import { pool } from "../db.js";
import { auth, requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { getStorage } from "../lib/storage/index.js";
import { writeExport } from "../plans/dataExport.js";
import type { Q } from "../plans/state.js";

const router = Router();

router.get("/", auth, requireAuthorization({ roles: [ROLES.ADMIN] }), safeHandler(async (req: any, res) => {
  const day = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="data-export-${day}.zip"`);
  res.setHeader("Cache-Control", "no-store");
  console.info("[data-export] started", { by: String(req.user?.email ?? req.user?.id ?? "") });
  const manifest = await writeExport(pool as unknown as Q, res, {
    fetchBlob: async (key) => (await getStorage().get(key))?.buffer ?? null,
  });
  console.info("[data-export] finished", { tables: manifest.tables.length, documents: manifest.documents, errors: manifest.errors.length });
}));

export default router;
