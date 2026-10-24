// KS_SERVER_v8_OPS_LINK - this copy's link to Keystone operations (KS-Ops).
//   KS_OPS_URL      KS-Ops base URL
//   KS_LICENSEE_ID  the id KS-Ops gave this licensee
//   KS_OPS_KEY      shared secret, sent as X-KS-Ops-Key (the same key KS-Ops uses for PUT /api/plan here)
// Every call is best effort: a failure is returned (and logged by the caller), never thrown.

export type OpsConfig = { url: string; licenseeId: string; key: string };
export type OpsFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) =>
  Promise<{ ok: boolean; status: number; json: () => Promise<any>; text: () => Promise<string> }>;

export type OpsResult = { ok: true; status: number; body: any } | { ok: false; status: number | null; error: string };

export const OPS_TIMEOUT_MS = 15_000;

/** The link settings, or null when any of the three is missing. */
export function opsConfig(env: NodeJS.ProcessEnv = process.env): OpsConfig | null {
  const url = String(env.KS_OPS_URL ?? "").trim().replace(/\/+$/, "");
  const licenseeId = String(env.KS_LICENSEE_ID ?? "").trim();
  const key = String(env.KS_OPS_KEY ?? "").trim();
  if (!url || !licenseeId || !key) return null;
  return { url, licenseeId, key };
}

/** POST {KS_OPS_URL}/api/licensees/{KS_LICENSEE_ID}/{path} with the ops key. */
export async function postToOps(
  // KS_SERVER_v9_FRAUD - the shared watchlist paths (see src/fraud/watchlist.ts).
  path: "usage-reports" | "requests" | "tickets" | "watchlist/report" | "watchlist/withdraw" | "watchlist/check" | "watchlist/opt-in"
    // KS_STAFF_DIRECTORY_v1 - the staff list (hashes only, see src/staffDirectory/sync.ts).
    | "staff-directory",
  body: unknown,
  opts: { env?: NodeJS.ProcessEnv; fetchImpl?: OpsFetch } = {},
): Promise<OpsResult> {
  const cfg = opsConfig(opts.env);
  if (!cfg) return { ok: false, status: null, error: "ops_not_configured" };
  const doFetch: OpsFetch = opts.fetchImpl ?? (globalThis.fetch as unknown as OpsFetch);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), OPS_TIMEOUT_MS);
  try {
    const r = await doFetch(`${cfg.url}/api/licensees/${encodeURIComponent(cfg.licenseeId)}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-KS-Ops-Key": cfg.key },
      body: JSON.stringify(body ?? {}),
      signal: ctrl.signal,
    });
    if (!r.ok) {
      let detail = "";
      try { detail = (await r.text()).slice(0, 200); } catch (err) { detail = String(err).slice(0, 200); }
      return { ok: false, status: r.status, error: `status_${r.status}${detail ? `: ${detail}` : ""}` };
    }
    let parsed: any = null;
    try { parsed = await r.json(); } catch (err) { console.warn("[ops-link] reply was not JSON", path, String(err)); }
    return { ok: true, status: r.status, body: parsed };
  } catch (err) {
    return { ok: false, status: null, error: (err as { message?: string })?.message ?? String(err) };
  } finally {
    clearTimeout(timer);
  }
}
