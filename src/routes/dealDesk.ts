// KS_BROKER_TOOLS - /api/deal-desk: the broker tools behind the application's Deal desk tab and Settings > Deal tools.
// Each part is its own router; each route checks its own plan feature, role and (for /applications/:id) the caller's
// silo and record visibility.
import { Router } from "express";
import invoices from "./dealDesk/invoices.js"; // KS_BROKER_TOOLS_INVOICES
import rateCards from "./dealDesk/rateCards.js"; // KS_BROKER_TOOLS_RATE_CARDS
import vendors from "./dealDesk/vendors.js"; // KS_BROKER_TOOLS_VENDORS
import creditBureau from "./dealDesk/creditBureau.js"; // KS_BROKER_TOOLS_CREDIT_BUREAU

// KS_SERVER_REMOVED_DEAL_TOOLS - approved credit lines, credit scorecards and contract templates were removed
// (Todd and Andrew, Nov 11 2026); their routers are no longer mounted. Their tables and data stay.
const router = Router();
router.use(invoices);
router.use(rateCards);
router.use(vendors);
router.use(creditBureau);

export default router;
