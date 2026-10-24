// KS_SERVER_v13_QUICKBOOKS - the media fee invoice for one application, kept in step with QuickBooks.
//
// quickbooks_invoices is both the record (invoice id, number, amount, status, synced_at) and the outbox: a row with
// next_attempt_at set has work to do. Work is idempotent - running it twice never makes a second customer, invoice or
// payment:
//   1. Signed agreement, no invoice yet  -> find or create the customer, create the invoice on the requested amount.
//   2. Application funded                -> move the invoice to the funded amount, then record a Payment (paid).
// Each create carries an Intuit requestid derived from the application, so a retry after a lost answer gets the
// first result back instead of a duplicate. Failures are logged and retried with backoff (1m, 5m, 15m, 1h, 3h, 6h);
// after that the row is "failed" until someone presses Retry on the application card.
import type { Pool } from "pg";
import { createHash } from "node:crypto";
import { QboApiError, getQboClient, loadConnection, type QboClient } from "./qboAuth.js";
import { qboConfig, qboConfigProblem } from "./qboConfig.js";
import { mediaFee, roundCents } from "./feeMath.js";

export const FEE_ITEM_NAME = "Media funding fee";
export const BACKOFF_MINUTES = [1, 5, 15, 60, 180, 360];
const LOCK_MINUTES = 5;

const reqId = (...parts: Array<string | number>) => createHash("sha256").update(["ks", ...parts].join(":")).digest("hex").slice(0, 40);
export const qboQuote = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
const errText = (err: unknown) => {
  if (err instanceof QboApiError) return [err.message, err.detail].filter(Boolean).join(" - ").slice(0, 500);
  return (err instanceof Error ? err.message : String(err)).slice(0, 500);
};

/** Queue the application's invoice work (after a signature or funding). Never throws; does nothing while off. */
export async function enqueueQuickBooksSync(pool: Pool, applicationId: string, reason: string): Promise<boolean> {
  if (!applicationId || qboConfigProblem()) return false;
  try {
    const r = await pool.query(
      `INSERT INTO quickbooks_invoices (application_id, sync_status, next_attempt_at, attempts, updated_at)
       SELECT $1::text, 'queued', now(), 0, now()
        WHERE EXISTS (SELECT 1 FROM quickbooks_connection WHERE id = 1 AND status = 'connected')
       ON CONFLICT (application_id) DO UPDATE
         SET sync_status = 'queued', next_attempt_at = now(), attempts = 0, updated_at = now()
       WHERE quickbooks_invoices.status <> 'paid'`,
      [applicationId],
    );
    const queued = (r.rowCount ?? 0) > 0;
    if (queued) console.info({ event: "quickbooks_invoice_queued", applicationId, reason });
    return queued;
  } catch (err) {
    console.error("[quickbooks] could not queue invoice work", { applicationId, reason, message: errText(err) });
    return false;
  }
}

/** Queue the work and run it now in the background (the worker picks it up later if this fails). */
export function syncSoon(pool: Pool, applicationId: string, reason: string): void {
  void (async () => {
    if (await enqueueQuickBooksSync(pool, applicationId, reason)) await processInvoiceJob(pool, applicationId);
  })().catch((err) => console.error("[quickbooks] immediate sync failed", { applicationId, reason, message: errText(err) }));
}

type AppRow = {
  id: string; name: string | null; requested_amount: string | number | null; funded_amount: string | number | null;
  funded_at: string | Date | null; metadata: any; fee_status: string | null; fee_percent: string | null; fee_amount: string | null;
  signer_name: string | null; signer_email: string | null;
};

type InvoiceRow = {
  application_id: string; realm_id: string | null; customer_id: string | null; invoice_id: string | null; doc_number: string | null;
  amount: string | null; funded: boolean; payment_id: string | null; status: string; attempts: number;
};

const obj = (v: unknown): Record<string, any> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : {});
const str = (v: unknown): string | null => { const s = typeof v === "string" ? v.trim() : ""; return s || null; };

export function customerFor(app: Pick<AppRow, "name" | "metadata" | "signer_name" | "signer_email">): { displayName: string; companyName: string | null; email: string | null } {
  const md = obj(app.metadata), business = obj(md.business), applicant = obj(md.applicant);
  const company = str(business.legalName) ?? str(business.companyName) ?? str(business.businessName) ?? str(app.name);
  const person = str(app.signer_name) ?? ([str(applicant.firstName), str(applicant.lastName)].filter(Boolean).join(" ") || null);
  const displayName = (company ?? person ?? "Client").replace(/:/g, " ").slice(0, 100).trim();
  return { displayName, companyName: company, email: str(app.signer_email) ?? str(applicant.email) };
}

async function findOrCreateCustomer(q: QboClient, applicationId: string, app: AppRow): Promise<string> {
  const c = customerFor(app);
  const found = await q.query<{ Id: string }>(`select Id from Customer where DisplayName = '${qboQuote(c.displayName)}'`);
  if (found[0]?.Id) return String(found[0].Id);
  const r = await q.request<any>("POST", "customer", {
    requestId: reqId("customer", applicationId),
    body: {
      DisplayName: c.displayName,
      ...(c.companyName ? { CompanyName: c.companyName.slice(0, 100) } : {}),
      ...(c.email ? { PrimaryEmailAddr: { Address: c.email } } : {}),
    },
  });
  const id = r?.Customer?.Id;
  if (!id) throw new Error("quickbooks_customer_not_created");
  return String(id);
}

async function feeItemId(pool: Pool, q: QboClient, stored: string | null): Promise<string> {
  if (stored) return stored;
  let id: string | null = null;
  const found = await q.query<{ Id: string }>(`select Id from Item where Name = '${qboQuote(FEE_ITEM_NAME)}'`);
  if (found[0]?.Id) id = String(found[0].Id);
  if (!id) {
    const accounts = await q.query<{ Id: string }>(`select Id from Account where AccountType = 'Income' and Active = true maxresults 1`);
    if (!accounts[0]?.Id) throw new Error("quickbooks_no_income_account");
    const r = await q.request<any>("POST", "item", {
      requestId: reqId("item", q.realmId),
      body: { Name: FEE_ITEM_NAME, Type: "Service", IncomeAccountRef: { value: String(accounts[0].Id) } },
    });
    id = r?.Item?.Id ? String(r.Item.Id) : null;
    if (!id) throw new Error("quickbooks_item_not_created");
  }
  await pool.query(`UPDATE quickbooks_connection SET item_id = $1, updated_at = now() WHERE id = 1`, [id]);
  return id;
}

function invoiceLine(itemId: string, amount: number, description: string, taxCodeId: string | null) {
  return {
    DetailType: "SalesItemLineDetail",
    Amount: amount,
    Description: description,
    SalesItemLineDetail: { ItemRef: { value: itemId }, Qty: 1, UnitPrice: amount, ...(taxCodeId ? { TaxCodeRef: { value: taxCodeId } } : {}) },
  };
}

export type SyncOutcome = { ok: true; status: string; invoiceId: string | null } | { ok: false; skipped: string };

/** Bring the application's invoice up to date. Throws on a QuickBooks or database error (the caller retries). */
export async function syncApplicationInvoice(pool: Pool, applicationId: string): Promise<SyncOutcome> {
  const conn = await loadConnection(pool);
  const q = await getQboClient(pool, qboConfig());
  if (!conn || !q) return { ok: false, skipped: "not_connected" };
  const app = (await pool.query<AppRow>(
    `SELECT a.id::text AS id, a.name, a.requested_amount, a.funded_amount, a.funded_at, a.metadata,
            m.status AS fee_status, m.fee_percent::text AS fee_percent, m.fee_amount::text AS fee_amount, m.signer_name, m.signer_email
       FROM applications a
       LEFT JOIN media_fee_agreements m ON m.application_id = a.id::text
      WHERE a.id::text = $1`,
    [applicationId],
  )).rows[0];
  if (!app) return { ok: false, skipped: "application_not_found" };
  if (app.fee_status !== "signed") return { ok: false, skipped: "agreement_not_signed" };
  const row = (await pool.query<InvoiceRow>(
    `SELECT application_id, realm_id, customer_id, invoice_id, doc_number, amount::text AS amount, funded, payment_id, status, attempts
       FROM quickbooks_invoices WHERE application_id = $1`,
    [applicationId],
  )).rows[0];
  if (row?.invoice_id && row.realm_id && row.realm_id !== q.realmId) {
    throw new Error("quickbooks_company_changed: this invoice was made in another QuickBooks company");
  }
  const funded = Boolean(app.funded_at);
  const fee = mediaFee({ feePercent: app.fee_percent, feeAmount: app.fee_amount, requestedAmount: app.requested_amount, fundedAmount: app.funded_amount, funded });
  if (!fee) return { ok: false, skipped: "no_amount" };
  const itemId = await feeItemId(pool, q, conn.item_id);
  const save = async (fields: Record<string, unknown>) => {
    const keys = Object.keys(fields);
    await pool.query(
      `UPDATE quickbooks_invoices SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_at = now() WHERE application_id = $1`,
      [applicationId, ...keys.map((k) => fields[k])],
    );
  };

  let invoiceId = row?.invoice_id ?? null;
  let customerId = row?.customer_id ?? null;
  let amount = row?.amount !== null && row?.amount !== undefined ? Number(row.amount) : null;
  let status = row?.status ?? "none";

  // 1. The invoice.
  if (!invoiceId) {
    customerId = customerId ?? await findOrCreateCustomer(q, applicationId, app);
    await save({ customer_id: customerId, realm_id: q.realmId });
    const r = await q.request<any>("POST", "invoice", {
      requestId: reqId("invoice", applicationId),
      body: {
        CustomerRef: { value: customerId },
        Line: [invoiceLine(itemId, fee.amount, fee.description, conn.tax_code_id)],
        PrivateNote: `Keystone application ${applicationId}`,
        ...(customerFor(app).email ? { BillEmail: { Address: customerFor(app).email } } : {}),
      },
    });
    const inv = r?.Invoice;
    if (!inv?.Id) throw new Error("quickbooks_invoice_not_created");
    invoiceId = String(inv.Id);
    amount = fee.amount;
    status = "open";
    await save({ invoice_id: invoiceId, doc_number: inv.DocNumber ? String(inv.DocNumber) : null, amount, fee_percent: fee.percent, base_amount: fee.base, status, synced_at: new Date() });
    console.info({ event: "quickbooks_invoice_created", applicationId, invoiceId, amount });
  }

  // 2. Funding: the invoice moves to the funded amount, then it is paid.
  if (funded && status !== "paid") {
    if (amount === null || roundCents(amount) !== fee.amount) {
      const current = (await q.request<any>("GET", `invoice/${encodeURIComponent(invoiceId)}`))?.Invoice;
      if (!current?.SyncToken && current?.SyncToken !== "0") throw new Error("quickbooks_invoice_missing");
      const r = await q.request<any>("POST", "invoice", {
        requestId: reqId("invoice-update", applicationId, fee.amount.toFixed(2)),
        body: { Id: invoiceId, SyncToken: String(current.SyncToken), sparse: true, Line: [invoiceLine(itemId, fee.amount, fee.description, conn.tax_code_id)] },
      });
      const inv = r?.Invoice ?? {};
      amount = fee.amount;
      await save({ amount, fee_percent: fee.percent, base_amount: fee.base, doc_number: inv.DocNumber ? String(inv.DocNumber) : row?.doc_number ?? null, synced_at: new Date() });
      console.info({ event: "quickbooks_invoice_updated", applicationId, invoiceId, amount });
    }
    if (!row?.payment_id) {
      const current = (await q.request<any>("GET", `invoice/${encodeURIComponent(invoiceId)}`))?.Invoice ?? {};
      const total = Number(current.TotalAmt ?? amount);
      const due = Number(current.Balance ?? total);
      const custId = String(current?.CustomerRef?.value ?? customerId ?? "");
      if (due > 0) {
        const r = await q.request<any>("POST", "payment", {
          requestId: reqId("payment", applicationId),
          body: { CustomerRef: { value: custId }, TotalAmt: roundCents(due), Line: [{ Amount: roundCents(due), LinkedTxn: [{ TxnId: invoiceId, TxnType: "Invoice" }] }], PrivateNote: `Media funding fee paid at funding - Keystone application ${applicationId}` },
        });
        const paymentId = r?.Payment?.Id ? String(r.Payment.Id) : null;
        if (!paymentId) throw new Error("quickbooks_payment_not_created");
        await save({ payment_id: paymentId });
        console.info({ event: "quickbooks_payment_recorded", applicationId, invoiceId, paymentId, amount: due });
      }
    }
    status = "paid";
    await save({ status, funded: true, synced_at: new Date() });
  }
  return { ok: true, status, invoiceId };
}

/** Claim and run one queued row. Never throws; failures are recorded on the row and logged. */
export async function processInvoiceJob(pool: Pool, applicationId: string): Promise<"done" | "skipped" | "retrying" | "failed" | "busy"> {
  const claimed = await pool.query<{ attempts: number }>(
    `UPDATE quickbooks_invoices SET locked_until = now() + ($2 || ' minutes')::interval
      WHERE application_id = $1 AND next_attempt_at IS NOT NULL AND (locked_until IS NULL OR locked_until < now())
      RETURNING attempts`,
    [applicationId, String(LOCK_MINUTES)],
  );
  if (!claimed.rows[0]) return "busy";
  const attempts = Number(claimed.rows[0].attempts ?? 0) + 1;
  try {
    const out = await syncApplicationInvoice(pool, applicationId);
    if (!out.ok) {
      // Nothing to do yet (not signed, no amount) or not connected: leave the row idle, no error shown.
      const why = out.skipped === "not_connected" ? "QuickBooks is not connected." : null;
      await pool.query(
        `UPDATE quickbooks_invoices SET sync_status = CASE WHEN $2::text IS NULL THEN 'ok' ELSE 'failed' END, last_error = $2,
                next_attempt_at = NULL, locked_until = NULL, updated_at = now() WHERE application_id = $1`,
        [applicationId, why],
      );
      if (why) console.warn("[quickbooks] invoice work skipped", { applicationId, reason: out.skipped });
      return "skipped";
    }
    await pool.query(
      `UPDATE quickbooks_invoices SET sync_status = 'ok', last_error = NULL, attempts = 0, next_attempt_at = NULL, locked_until = NULL,
              synced_at = now(), updated_at = now() WHERE application_id = $1`,
      [applicationId],
    );
    return "done";
  } catch (err) {
    const message = errText(err);
    const gaveUp = attempts > BACKOFF_MINUTES.length;
    const wait = BACKOFF_MINUTES[Math.min(attempts - 1, BACKOFF_MINUTES.length - 1)]!;
    console.error("[quickbooks] invoice sync failed", { applicationId, attempts, gaveUp, message });
    await pool.query(
      `UPDATE quickbooks_invoices SET sync_status = $2, last_error = $3, attempts = $4,
              next_attempt_at = CASE WHEN $2 = 'failed' THEN NULL ELSE now() + ($5 || ' minutes')::interval END,
              locked_until = NULL, updated_at = now()
        WHERE application_id = $1`,
      [applicationId, gaveUp ? "failed" : "retrying", message, attempts, String(wait)],
    );
    return gaveUp ? "failed" : "retrying";
  }
}

/**
 * Safety net for anything a hook missed: queue signed agreements (signed after QuickBooks was connected) that have
 * no invoice row, and invoices whose application has since been funded.
 */
export async function sweepForInvoiceWork(pool: Pool): Promise<number> {
  const a = await pool.query(
    `INSERT INTO quickbooks_invoices (application_id, sync_status, next_attempt_at)
     SELECT m.application_id, 'queued', now()
       FROM media_fee_agreements m
       JOIN quickbooks_connection c ON c.id = 1 AND c.status = 'connected'
      WHERE m.status = 'signed' AND m.signed_at >= c.connected_at
     ON CONFLICT (application_id) DO NOTHING`,
  );
  const b = await pool.query(
    `UPDATE quickbooks_invoices q SET sync_status = 'queued', next_attempt_at = now(), updated_at = now()
       FROM applications a
      WHERE a.id::text = q.application_id AND a.funded_at IS NOT NULL
        AND q.status = 'open' AND q.sync_status = 'ok' AND q.next_attempt_at IS NULL`,
  );
  return (a.rowCount ?? 0) + (b.rowCount ?? 0);
}

/** One worker pass: sweep, then run every due row (oldest first). */
export async function runInvoiceWorkerOnce(pool: Pool, limit = 25): Promise<{ queued: number; ran: number }> {
  if (qboConfigProblem()) return { queued: 0, ran: 0 };
  const conn = await loadConnection(pool);
  if (!conn || conn.status !== "connected") return { queued: 0, ran: 0 };
  const queued = await sweepForInvoiceWork(pool);
  const due = await pool.query<{ application_id: string }>(
    `SELECT application_id FROM quickbooks_invoices
      WHERE next_attempt_at IS NOT NULL AND next_attempt_at <= now() AND (locked_until IS NULL OR locked_until < now())
      ORDER BY next_attempt_at ASC LIMIT $1`,
    [limit],
  );
  let ran = 0;
  for (const { application_id } of due.rows) {
    const r = await processInvoiceJob(pool, application_id);
    if (r !== "busy") ran++;
  }
  return { queued, ran };
}

export type InvoiceView = {
  configured: boolean; connected: boolean; invoice: null | {
    invoiceId: string | null; docNumber: string | null; amount: number | null; status: string; syncStatus: string;
    lastError: string | null; syncedAt: string | null; canRetry: boolean;
  };
};

export async function invoiceForApplication(pool: Pool, applicationId: string): Promise<InvoiceView> {
  const problem = qboConfigProblem();
  if (problem) return { configured: false, connected: false, invoice: null };
  const conn = await loadConnection(pool);
  const r = await pool.query<any>(
    `SELECT invoice_id, doc_number, amount::text AS amount, status, sync_status, last_error, synced_at
       FROM quickbooks_invoices WHERE application_id = $1`,
    [applicationId],
  );
  const row = r.rows[0];
  return {
    configured: true,
    connected: conn?.status === "connected",
    invoice: row ? {
      invoiceId: row.invoice_id ?? null,
      docNumber: row.doc_number ?? null,
      amount: row.amount === null || row.amount === undefined ? null : Number(row.amount),
      status: row.status,
      syncStatus: row.sync_status,
      lastError: row.last_error ?? null,
      syncedAt: row.synced_at ? new Date(row.synced_at).toISOString() : null,
      canRetry: row.sync_status === "failed" || row.sync_status === "retrying",
    } : null,
  };
}
