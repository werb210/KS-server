// KS_SERVER_LICENSEE_DOCUMENTS - GET /api/client/extra-questions: the questions on the brokerage's own documents that the
// standard application does not ask. The client wizard shows them on the review step; answers are saved in the
// application's metadata.extra_answers (by key) through the usual application update.
import { Router } from "express";
import { safeHandler } from "../middleware/safeHandler.js";
import { db } from "../brokerTools/common.js";
import { listQuestions } from "../licenseeDocs/repo.js";

const router = Router();
router.get("/", safeHandler(async (_req: any, res: any) => {
  let rows: Awaited<ReturnType<typeof listQuestions>> = [];
  try { rows = await listQuestions(db(), { liveOnly: true }); }
  catch (err) { console.warn("[licensee-docs] extra questions not read", { message: err instanceof Error ? err.message : String(err) }); }
  const seen = new Set<string>();
  const questions = rows.filter((q) => (seen.has(q.key) ? false : (seen.add(q.key), true)))
    .map((q) => ({ key: q.key, label: q.label, type: q.type, options: q.options ?? [], required: q.required }));
  res.json({ ok: true, questions });
}));
export default router;
