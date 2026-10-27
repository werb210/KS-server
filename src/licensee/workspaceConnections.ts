// KS_SERVER_M365_ONE_CLICK - what Settings > Connections and KS-Ops show about Microsoft 365 and Google Workspace,
// in plain English: connected or not, to which organisation, by whom and when, which permissions, the last call that
// worked, and what to do when something is wrong.
import { m365Status, type Db, type M365Status } from "../modules/o365/m365Consent.js";
import { BASE_SCOPES, gmailReadEnabled, googleClientCredentials, googleConfigProblem } from "../services/workspace/googleConfig.js";
import { brokerConfig } from "./oauthBroker.js";

const GOOGLE_SCOPE_LABELS: Record<string, string> = {
  openid: "sign in",
  email: "your email address",
  profile: "your name",
  "https://www.googleapis.com/auth/gmail.send": "send email from Gmail",
  "https://www.googleapis.com/auth/calendar.events": "Google Calendar events and Meet links",
  "https://www.googleapis.com/auth/tasks": "Google Tasks",
  "https://www.googleapis.com/auth/drive.file": "client folders Keystone creates in Google Drive",
};

export type GoogleConnectionStatus = {
  available: boolean;
  app: "keystone" | "own" | null;
  state: "not_available" | "not_connected" | "connected" | "needs_reconnect";
  headline: string;
  fix: string | null;
  domains: string[];
  staff_connected: number;
  staff_needing_reconnect: number;
  first_connected_at: string | null;
  permissions: Array<{ name: string; label: string }>;
  gmail_reading: false | true;
  last_sync_at: string | null;
};

export async function googleStatus(db: Db): Promise<GoogleConnectionStatus> {
  const creds = googleClientCredentials();
  const problem = googleConfigProblem();
  const permissions = BASE_SCOPES.map((name) => ({ name, label: GOOGLE_SCOPE_LABELS[name] ?? name }));
  const [acc, row] = await Promise.all([
    db.query(
      `SELECT count(*) FILTER (WHERE status = 'connected')::int AS ok,
              count(*) FILTER (WHERE status <> 'connected')::int AS bad,
              min(connected_at) AS first_at,
              array_remove(array_agg(DISTINCT lower(split_part(google_email, '@', 2))), '') AS domains
         FROM google_workspace_accounts`,
    ),
    db.query(`SELECT google_last_sync_at FROM licensee_settings WHERE id = 1`),
  ]);
  const ok = Number(acc.rows[0]?.ok ?? 0);
  const bad = Number(acc.rows[0]?.bad ?? 0);
  const domains = (Array.isArray(acc.rows[0]?.domains) ? acc.rows[0].domains : []).map(String).filter(Boolean).sort();
  const base = {
    available: !problem,
    app: creds?.source ?? null,
    domains,
    staff_connected: ok,
    staff_needing_reconnect: bad,
    first_connected_at: acc.rows[0]?.first_at ? new Date(acc.rows[0].first_at).toISOString() : null,
    permissions,
    gmail_reading: gmailReadEnabled(),
    last_sync_at: row.rows[0]?.google_last_sync_at ? new Date(row.rows[0].google_last_sync_at).toISOString() : null,
  };
  if (problem) return { ...base, state: "not_available", headline: "Google Workspace is not available on this server yet.", fix: "Keystone sets this up for you. Contact Keystone support if it stays like this." };
  if (ok === 0 && bad === 0) return { ...base, state: "not_connected", headline: "Nobody has connected Google yet.", fix: "Each person clicks Connect Google in My Profile and approves once. No setup is needed first." };
  const where = domains.length ? domains.join(", ") : "Google";
  if (bad > 0) {
    return { ...base, state: "needs_reconnect", headline: `${ok} ${ok === 1 ? "person is" : "people are"} connected to ${where}; ${bad} need${bad === 1 ? "s" : ""} to reconnect.`, fix: "Google stopped accepting some connections (access removed or expired). Those people click Reconnect Google in My Profile." };
  }
  return { ...base, state: "connected", headline: `${ok} ${ok === 1 ? "person is" : "people are"} connected to ${where}.`, fix: null };
}

export async function workspaceConnections(db: Db, opts: { refresh?: boolean } = {}): Promise<{ microsoft: M365Status; google: GoogleConnectionStatus; broker: boolean }> {
  const [microsoft, google] = await Promise.all([m365Status(db, opts), googleStatus(db)]);
  return { microsoft, google, broker: Boolean(brokerConfig()) };
}

/** For KS-Ops (Keystone staff): connected or not and whether something needs fixing. No names or email addresses. */
export async function opsConnectionsView(db: Db) {
  const c = await workspaceConnections(db);
  return {
    microsoft: {
      available: c.microsoft.available,
      state: c.microsoft.state,
      // The page's headline names the person who connected; KS-Ops gets the same sentence without the name.
      headline: c.microsoft.state === "connected" || c.microsoft.state === "partial"
        ? `Connected to ${c.microsoft.domain ?? c.microsoft.tenant_id}${c.microsoft.connected_at ? ` on ${c.microsoft.connected_at.slice(0, 10)}` : ""}.`
        : c.microsoft.headline,
      tenant_id: c.microsoft.tenant_id,
      domain: c.microsoft.domain,
      connected_at: c.microsoft.connected_at,
      staff_connected: c.microsoft.staff_connected,
      last_sync_at: c.microsoft.last_sync_at,
      missing_permissions: c.microsoft.permissions.application.filter((p) => p.granted === false).map((p) => p.name),
    },
    google: {
      available: c.google.available,
      state: c.google.state,
      headline: c.google.headline,
      domains: c.google.domains,
      staff_connected: c.google.staff_connected,
      last_sync_at: c.google.last_sync_at,
    },
    broker: c.broker,
  };
}
