// KS_BROKER_TOOLS - /api/deal-desk: the broker tools behind the application's Deal desk tab and Settings > Deal tools.
// Each part is its own router; each route checks its own plan feature, role and (for /applications/:id) the caller's
// silo and record visibility.
import { Router } from "express";
import invoices from "./dealDesk/invoices.js"; // KS_BROKER_TOOLS_INVOICES
import creditLines from "./dealDesk/creditLines.js"; // KS_BROKER_TOOLS_CREDIT_LINES

const router = Router();
router.use(invoices);
router.use(creditLines);

export default router;
