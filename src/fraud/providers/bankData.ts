// KS_SERVER_v9_FRAUD - live bank data for check 3 (uploaded statement vs the bank's own data).
//
// Flinks: the client connects their bank in Flinks Connect; the resulting LoginId is saved on the application
// (POST /api/fraud/applications/:id/bank-link). With FLINKS_BASE_URL (the instance API host, e.g.
// https://<instance>-api.private.fin.ag) and FLINKS_CUSTOMER_ID set, the worker asks Flinks for the cached account
// details and transactions. Without them the check reports "not set up" - it never invents a comparison.
import { defaultFetch, networkAllowed, requestJson, type FetchLike } from "./http.js";

export type LiveTx = { date: string; description: string; amount: number; balance: number | null; account: string };

export type BankFetch = { ok: true; transactions: LiveTx[] } | { ok: false; error: string };

export interface BankDataProvider {
  readonly name: string;
  configured(): boolean;
  fetchTransactions(loginId: string): Promise<BankFetch>;
}

function isoDate(v: unknown): string | null {
  const s = String(v ?? "").trim();
  const m = s.match(/^(\d{4})[/-](\d{2})[/-](\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** Flinks GetAccountsDetail -> flat transactions (credit positive, debit negative). Exported for tests. */
export function flinksTransactions(body: any): LiveTx[] {
  const out: LiveTx[] = [];
  const accounts = Array.isArray(body?.Accounts) ? body.Accounts : [];
  accounts.forEach((a: any, idx: number) => {
    const acct = String(a?.Id ?? a?.AccountNumber ?? idx);
    for (const t of Array.isArray(a?.Transactions) ? a.Transactions : []) {
      const date = isoDate(t?.Date);
      const credit = Number(t?.Credit ?? 0) || 0;
      const debit = Number(t?.Debit ?? 0) || 0;
      if (!date || (credit === 0 && debit === 0)) continue;
      const bal = t?.Balance == null ? null : Number(t.Balance);
      out.push({ date, description: String(t?.Description ?? ""), amount: Math.round((credit - debit) * 100) / 100, balance: Number.isFinite(bal) ? bal : null, account: acct });
    }
  });
  return out;
}

export function flinksProvider(env: NodeJS.ProcessEnv = process.env, fetchImpl?: FetchLike): BankDataProvider {
  const base = String(env.FLINKS_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const customer = String(env.FLINKS_CUSTOMER_ID ?? "").trim();
  const authKey = String(env.FLINKS_AUTH_KEY ?? "").trim();
  const f = fetchImpl ?? defaultFetch();
  const headers: Record<string, string> = authKey ? { "flinks-auth-key": authKey } : {};
  return {
    name: "flinks",
    configured: () => Boolean(base && customer) && networkAllowed(fetchImpl, env),
    async fetchTransactions(loginId: string): Promise<BankFetch> {
      if (!base || !customer) return { ok: false, error: "not_configured" };
      const root = `${base}/v3/${encodeURIComponent(customer)}/BankingServices`;
      const auth = await requestJson(f, `${root}/Authorize`, { headers, body: { LoginId: loginId, MostRecentCached: true }, timeoutMs: 20_000 });
      if (!auth.ok) return { ok: false, error: `authorize_${auth.error}` };
      const requestId = String(auth.body?.RequestId ?? "");
      if (!requestId) return { ok: false, error: "authorize_no_request_id" };
      let detail = await requestJson(f, `${root}/GetAccountsDetail`, { headers, body: { RequestId: requestId, WithTransactions: true, DaysOfTransactions: "Days365" }, timeoutMs: 30_000 });
      // 202 = Flinks is still fetching; poll the async endpoint a few times.
      for (let i = 0; i < 4 && detail.ok && (detail.status === 202 || detail.body?.FlinksCode === "OPERATION_PENDING"); i++) {
        await new Promise((r) => setTimeout(r, 3_000));
        detail = await requestJson(f, `${root}/GetAccountsDetailAsync/${encodeURIComponent(requestId)}`, { headers, timeoutMs: 30_000 });
      }
      if (!detail.ok) return { ok: false, error: `detail_${detail.error}` };
      if (detail.status === 202) return { ok: false, error: "detail_still_pending" };
      return { ok: true, transactions: flinksTransactions(detail.body) };
    },
  };
}
