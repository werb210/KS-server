// KS_BROKER_TOOLS - /api/deal-desk: the broker tools behind the application's Deal desk tab and Settings > Deal tools.
// Each part is its own router; each route checks its own plan feature, role and (for /applications/:id) the caller's
// silo and record visibility.
import { Router } from "express";
import invoices from "./dealDesk/invoices.js"; // KS_BROKER_TOOLS_INVOICES
import creditLines from "./dealDesk/creditLines.js"; // KS_BROKER_TOOLS_CREDIT_LINES
import rateCards from "./dealDesk/rateCards.js"; // KS_BROKER_TOOLS_RATE_CARDS
import scorecards from "./dealDesk/scorecards.js"; // KS_BROKER_TOOLS_SCORECARDS
import contracts from "./dealDesk/contracts.js"; // KS_BROKER_TOOLS_CONTRACTS

const router = Router();
router.use(invoices);
router.use(creditLines);
router.use(rateCards);
router.use(scorecards);
router.use(contracts);

export default router;
