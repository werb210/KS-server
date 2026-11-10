// KS_SERVER_STORE_REVIEW_SEED_v1 - the sign-in Apple and Google reviewers use for the Keystone iPad portal and the
// Keystone dialler, with sample data to look at.
//
// It runs only on a TEST brokerage (KS_TEST_BROKERAGE=true with a QA code, see src/services/qaLogin.ts), never on a
// real licensee. It makes sure that brokerage has:
//   - a staff user "App Review", mobile (403) 555-0100 - a reserved fictional number that signs in with the
//     brokerage's QA code, no text sent - and
//   - a few sample companies, contacts, lenders and applications (fictional names, 555-01xx numbers, example.com
//     emails), added once and tagged sample_data so they are easy to find and remove.
// Nothing existing is changed. Safe to run on every start.
import { randomUUID } from "node:crypto";
import { qaLoginEnabled } from "../services/qaLogin.js";

type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

export const REVIEW_STAFF = {
  first: "App",
  last: "Review",
  email: "app.review@example.com",
  phone: "+14035550100",
} as const;

export const SAMPLE_LENDERS = [
  { name: "Prairie Equipment Capital", city: "Calgary", phone: "+14035550110" },
  { name: "Northline Business Lending", city: "Edmonton", phone: "+17805550111" },
] as const;

export const SAMPLE_FILES = [
  { company: "Maple Ridge Landscaping Ltd.", industry: "Landscaping", city: "Red Deer", first: "Jordan", last: "Pike",
    phone: "+14035550120", amount: 85000, product: "Equipment Financing", stage: "Received", status: "RECEIVED" },
  { company: "Bow Valley Coffee Co.", industry: "Food and beverage", city: "Canmore", first: "Priya", last: "Shah",
    phone: "+14035550121", amount: 40000, product: "Working Capital", stage: "In Review", status: "IN_REVIEW" },
  { company: "Summit Haulage Inc.", industry: "Trucking", city: "Lethbridge", first: "Marc", last: "Gagnon",
    phone: "+14035550122", amount: 220000, product: "Equipment Financing", stage: "Offer", status: "OFF_TO_LENDER" },
] as const;

const digits10 = (p: string) => p.replace(/\D/g, "").slice(-10);

/** Makes sure the reviewer staff user exists. Returns its id. */
export async function ensureReviewStaff(q: Q): Promise<string> {
  const found = await q.query(
    `SELECT id FROM users
      WHERE right(regexp_replace(coalesce(phone_number, ''), '[^0-9]', '', 'g'), 10) = $1
         OR right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10) = $1
      LIMIT 1`,
    [digits10(REVIEW_STAFF.phone)],
  );
  if (found.rows[0]) return String(found.rows[0].id);
  const id = randomUUID();
  await q.query(
    `INSERT INTO users (id, email, phone_number, phone, role, active, is_active, disabled, phone_verified, status, first_name, last_name)
     VALUES ($1, $2, $3, $3, 'Admin', true, true, false, true, 'ACTIVE', $4, $5)
     ON CONFLICT DO NOTHING`,
    [id, REVIEW_STAFF.email, REVIEW_STAFF.phone, REVIEW_STAFF.first, REVIEW_STAFF.last],
  );
  return id;
}

/** Adds the sample records once (skipped when any sample_data application exists). Returns how many files it added. */
export async function ensureSampleData(q: Q, ownerId: string): Promise<number> {
  const has = await q.query(`SELECT 1 FROM applications WHERE metadata->>'sample_data' = 'true' LIMIT 1`);
  if (has.rows[0]) return 0;
  for (const l of SAMPLE_LENDERS) {
    await q.query(
      `INSERT INTO lenders (id, name, city, country, phone, active, silo)
       SELECT $1, $2::text, $3, 'CA', $4, true, 'BF'
        WHERE NOT EXISTS (SELECT 1 FROM lenders WHERE name = $2::text)`,
      [randomUUID(), l.name, l.city, l.phone],
    );
  }
  let added = 0;
  for (const f of SAMPLE_FILES) {
    const companyId = randomUUID();
    const contactId = randomUUID();
    const appId = randomUUID();
    await q.query(
      `INSERT INTO companies (id, name, legal_name, industry, city, province, country, phone, owner_id, silo)
       VALUES ($1, $2, $2, $3, $4, 'AB', 'CA', $5, $6, 'BF')`,
      [companyId, f.company, f.industry, f.city, f.phone, ownerId],
    );
    await q.query(
      `INSERT INTO contacts (id, company_id, name, first_name, last_name, email, phone, owner_id, silo, tags)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'BF', ARRAY['sample_data'])`,
      [contactId, companyId, `${f.first} ${f.last}`, f.first, f.last,
       `${f.first}.${f.last}@example.com`.toLowerCase(), f.phone, ownerId],
    );
    await q.query(
      `INSERT INTO applications (id, name, company_id, contact_id, requested_amount, product_category, pipeline_state,
                                 current_stage, status, silo, metadata, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, 'BF', $9::jsonb, now(), now())`,
      [appId, f.company, companyId, contactId, f.amount, f.product, f.stage, f.status, JSON.stringify({ sample_data: true })],
    );
    await q.query(
      `INSERT INTO application_contacts (application_id, contact_id, role) VALUES ($1, $2, 'applicant') ON CONFLICT DO NOTHING`,
      [appId, contactId],
    );
    added += 1;
  }
  return added;
}

/** Runs both steps when this is a test brokerage with QA sign-in; does nothing otherwise. */
export async function seedStoreReview(q: Q, env: NodeJS.ProcessEnv = process.env): Promise<{ ran: boolean; files: number }> {
  if (!qaLoginEnabled(env)) return { ran: false, files: 0 };
  const ownerId = await ensureReviewStaff(q);
  const files = await ensureSampleData(q, ownerId);
  return { ran: true, files };
}
