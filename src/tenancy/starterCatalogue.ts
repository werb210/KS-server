// KS_SERVER_STARTER_CATALOGUE - a new brokerage's clients can apply from the first minute.
// The client application asks the applicant to choose a kind of financing, and the choices come from the brokerage's
// own lender products. A brand-new brokerage has none, so its first client stopped at step 2 with "No financing
// products are currently available". Each new brokerage now starts with one entry per kind of financing under a
// clearly named starter lender. The owner replaces it with real lenders in Lenders (set-up step "Add your lenders and
// products"); it is added once only (settings key below), so removing it does not bring it back.
import { randomUUID } from "node:crypto";

type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

export const STARTER_MARKER = "starter_catalogue_added";
export const STARTER_LENDER_NAME = "Starter list (replace with your lenders)";
export const STARTER_PRODUCTS: ReadonlyArray<{ category: string; name: string; country: "BOTH" | "US" }> = [
  { category: "TERM", name: "Term loan", country: "BOTH" },
  { category: "LOC", name: "Line of credit", country: "BOTH" },
  { category: "EQUIPMENT", name: "Equipment financing", country: "BOTH" },
  { category: "FACTORING", name: "Factoring", country: "BOTH" },
  { category: "PO", name: "Purchase order financing", country: "BOTH" },
  { category: "MCA", name: "Merchant cash advance", country: "BOTH" },
  { category: "ABL", name: "Asset based lending", country: "BOTH" },
  { category: "MEDIA", name: "Media and film financing", country: "BOTH" },
  { category: "STARTUP", name: "Startup capital", country: "BOTH" },
  { category: "SBA", name: "SBA and government loans", country: "US" },
];

/** Adds the starter list to a brokerage that has never had it and has no lenders. Returns how many products it added. */
export async function seedStarterCatalogue(q: Q, country: string = String(process.env.KS_COUNTRY ?? "CA")): Promise<number> {
  const done = await q.query(`SELECT 1 FROM settings WHERE key = $1 LIMIT 1`, [STARTER_MARKER]);
  if (done.rows[0]) return 0;
  const any = await q.query(`SELECT 1 FROM lenders LIMIT 1`);
  let added = 0;
  if (!any.rows[0]) {
    const lenderId = randomUUID();
    await q.query(
      `INSERT INTO lenders (id, name, country, active, silo, description, internal_notes)
       VALUES ($1, $2, $3, true, 'BF', $4, $4)`,
      [lenderId, STARTER_LENDER_NAME, country.toUpperCase() === "US" ? "US" : "CA",
       "Added automatically so your clients can apply before you add lenders. It is not a real lender: add your own lenders and products, then remove this one."],
    );
    for (const p of STARTER_PRODUCTS) {
      await q.query(
        `INSERT INTO lender_products (id, lender_id, name, lender_name, type, category, country, active, status, silo, description)
         VALUES ($1, $2, $3, $4, $5, $5, $6, true, 'active', 'BF', $7)`,
        [randomUUID(), lenderId, p.name, STARTER_LENDER_NAME, p.category, p.country, "Starter entry: lets clients choose this kind of financing. Replace with your lenders' products."],
      );
      added += 1;
    }
  }
  await q.query(`INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`, [STARTER_MARKER, new Date().toISOString()]);
  return added;
}
