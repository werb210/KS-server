// KS_SERVER_M365_ONE_CLICK - which Microsoft app and which Microsoft 365 tenant this copy uses.
//
// Keystone owns ONE multi-tenant Entra app. KS-Ops writes its client id and secret to every licensee server as
// KS_M365_CLIENT_ID / KS_M365_CLIENT_SECRET during provisioning. A brokerage Admin then clicks "Connect Microsoft 365"
// (Settings > Connections): Microsoft's admin consent flow adds the app to their tenant, and the tenant id that comes
// back is saved in licensee_settings.office365_tenant_id. Nobody types a tenant id or registers an app.
//
// Older servers (Boreal's own, the development copy) still have their own app registration in MSAL_CLIENT_ID /
// MSAL_CLIENT_SECRET / MSAL_TENANT_ID and, for app-only calls, MS_GRAPH_*. Those keep working:
//   app:     MSAL_CLIENT_ID + MSAL_CLIENT_SECRET when both are set (existing sign-ins are bound to that app),
//            else KS_M365_CLIENT_ID + KS_M365_CLIENT_SECRET (Keystone's app)
//   tenant:  the saved licensee setting, else MSAL_TENANT_ID, else MS_GRAPH_TENANT_ID
//   app-only (shared mailboxes, Teams transcripts, bookings, lender email): MS_GRAPH_CLIENT_ID / _SECRET when set,
//            else the app above, always against the tenant above.
import { lastLoadedConnections } from "../../licensee/settings.js";

/** Delegated permissions each staff member's connection uses (Graph, "/me/..." and shared mailboxes they can open).
 *  Every one is used by the code: mail (inbox, drafts, send), shared mailboxes (read, move, send as), calendar and
 *  Teams meetings, To Do tasks, Outlook contacts, mailbox settings (signature, out of office), OneDrive files and
 *  presence. offline_access keeps the connection alive without daily sign-ins. */
export const DELEGATED_SCOPES = [
  "User.Read",
  "Mail.ReadWrite",
  "Mail.ReadWrite.Shared",
  "Mail.Send",
  "Mail.Send.Shared",
  "Calendars.ReadWrite",
  "Calendars.Read.Shared",
  "Tasks.ReadWrite",
  "Contacts.ReadWrite",
  "MailboxSettings.ReadWrite",
  "Presence.Read",
  "Files.ReadWrite",
  "offline_access",
] as const;
export const DELEGATED_SCOPE_STRING = DELEGATED_SCOPES.join(" ");

/** Application permissions (admin-consented, no signed-in user), each with what uses it. */
export const APPLICATION_PERMISSIONS: ReadonlyArray<{ name: string; why: string }> = [
  { name: "User.Read.All", why: "find a staff member's or shared mailbox's Microsoft account" },
  { name: "Mail.ReadWrite", why: "read shared mailboxes (incoming documents, bounced lender emails) and build large lender emails" },
  { name: "Mail.Send", why: "send lender packages and notices from the shared mailbox" },
  { name: "Calendars.ReadWrite", why: "client bookings, free/busy and meeting invites in staff calendars" },
  { name: "OnlineMeetings.ReadWrite.All", why: "turn on recording for Teams meetings booked from the CRM" },
  { name: "OnlineMeetingTranscript.Read.All", why: "file Teams meeting transcripts on the contact" },
  { name: "OnlineMeetingRecording.Read.All", why: "file Teams meeting recordings on the contact" },
];

/** Plain-English names for the delegated permissions, for the Connections page. */
export const DELEGATED_LABELS: Record<string, string> = {
  "User.Read": "sign in and read your profile",
  "Mail.ReadWrite": "read and organise your mail",
  "Mail.ReadWrite.Shared": "read and organise shared mailboxes you can open",
  "Mail.Send": "send mail as you",
  "Mail.Send.Shared": "send from shared mailboxes you can use",
  "Calendars.ReadWrite": "your calendar and Teams meetings",
  "Calendars.Read.Shared": "see calendars shared with you",
  "Tasks.ReadWrite": "your To Do tasks",
  "Contacts.ReadWrite": "your Outlook contacts",
  "MailboxSettings.ReadWrite": "signature and out-of-office",
  "Presence.Read": "your Teams presence",
  "Files.ReadWrite": "your OneDrive files",
  "offline_access": "stay connected",
};

const env = (name: string, e: NodeJS.ProcessEnv): string => String(e[name] ?? "").trim();
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isTenantGuid(v: unknown): v is string {
  return typeof v === "string" && GUID.test(v);
}

export type M365App = { clientId: string; clientSecret: string; source: "own" | "keystone" };

/** The Microsoft app this copy signs in with, or null when none is set up. */
export function m365App(e: NodeJS.ProcessEnv = process.env): M365App | null {
  const ownId = env("MSAL_CLIENT_ID", e);
  const ownSecret = env("MSAL_CLIENT_SECRET", e);
  if (ownId && ownSecret) return { clientId: ownId, clientSecret: ownSecret, source: "own" };
  const ksId = env("KS_M365_CLIENT_ID", e);
  const ksSecret = env("KS_M365_CLIENT_SECRET", e);
  if (ksId && ksSecret) return { clientId: ksId, clientSecret: ksSecret, source: "keystone" };
  return null;
}

/** The tenant an Admin connected (saved setting), or "" when none. */
export function storedM365Tenant(): string {
  return String(lastLoadedConnections()?.office365_tenant_id ?? "").trim();
}

export type TenantSource = "connected" | "server_settings" | "none";

/** The brokerage's Microsoft 365 tenant and where it came from. */
export function m365TenantInfo(e: NodeJS.ProcessEnv = process.env): { tenant: string; source: TenantSource } {
  const stored = storedM365Tenant();
  if (stored) return { tenant: stored, source: "connected" };
  const fromEnv = env("MSAL_TENANT_ID", e) || env("MS_GRAPH_TENANT_ID", e);
  if (fromEnv) return { tenant: fromEnv, source: "server_settings" };
  return { tenant: "", source: "none" };
}

export function m365Tenant(e: NodeJS.ProcessEnv = process.env): string {
  return m365TenantInfo(e).tenant;
}

/** Everything a delegated (per-user) Microsoft call needs, or null when Microsoft 365 cannot be used yet. */
export function m365Delegated(e: NodeJS.ProcessEnv = process.env): (M365App & { tenant: string }) | null {
  const app = m365App(e);
  const tenant = m365Tenant(e);
  if (!app || !tenant) return null;
  return { ...app, tenant };
}

export type AppOnlyCredentials = { tenant: string; clientId: string; clientSecret: string };

/** App-only (client credentials) settings: shared mailboxes, Teams transcripts, bookings, lender email. */
export function m365AppOnly(e: NodeJS.ProcessEnv = process.env): AppOnlyCredentials | null {
  const app = m365App(e);
  const own = Boolean(env("MS_GRAPH_CLIENT_ID", e));
  const clientId = own ? env("MS_GRAPH_CLIENT_ID", e) : app?.clientId ?? "";
  const clientSecret = own ? env("MS_GRAPH_CLIENT_SECRET", e) : app?.clientSecret ?? "";
  const stored = storedM365Tenant();
  const tenant = stored || env("MS_GRAPH_TENANT_ID", e) || env("MSAL_TENANT_ID", e);
  if (!tenant || !clientId || !clientSecret) return null;
  return { tenant, clientId, clientSecret };
}

/** The shared mailbox lender packages and notices are sent from: the saved setting, else MS_GRAPH_SEND_AS. */
export function m365SendAsMailbox(e: NodeJS.ProcessEnv = process.env): string {
  return String(lastLoadedConnections()?.office365_send_as ?? "").trim() || env("MS_GRAPH_SEND_AS", e);
}

/** Microsoft's token endpoint for a tenant. */
export function tokenEndpoint(tenant: string): string {
  return `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`;
}

/** The roles (application permissions) an app-only access token carries. Read locally; never logged. */
export function tokenRoles(accessToken: string): string[] {
  try {
    const part = String(accessToken ?? "").split(".")[1];
    if (!part) return [];
    const claims = JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return Array.isArray(claims.roles) ? claims.roles.map(String) : [];
  } catch {
    return [];
  }
}
