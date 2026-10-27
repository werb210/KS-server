// BF_SERVER_TEAMS_TRANSCRIPT_POLLER_v1
// App-only (client_credentials) Graph client. The Teams transcript + recording
// endpoints are Application-permission only and are addressed as
//   /users/{organizerUpn}/onlineMeetings/{id}/transcripts
// so they cannot use the delegated per-user client in modules/o365/graphClient.ts.
import { m365AppOnly, tokenEndpoint } from "../../modules/o365/m365App.js";
// Uses the same MS_GRAPH_* env trio as services/email/graphSendService.ts, which
// is already proven working for the app-only submissions pipeline.
// KS_SERVER_M365_ONE_CLICK - the tenant is the one the brokerage's admin connected (Settings > Connections), the app
// is Keystone's (or MS_GRAPH_* / MSAL_* on servers with their own registration). See modules/o365/m365App.ts.
let cachedToken: { token: string; expiresAt: number; key: string } | null = null;

export function isAppGraphConfigured(): boolean {
  return m365AppOnly() !== null;
}

async function getAppGraphToken(): Promise<string> {
  const creds = m365AppOnly();
  if (!creds) throw new Error("teams_graph_not_configured");
  const key = `${creds.tenant}|${creds.clientId}`;
  if (cachedToken && cachedToken.key === key && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.token;
  }
  const url = tokenEndpoint(creds.tenant);
  const body = new URLSearchParams({
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    grant_type: "client_credentials",
    scope: "https://graph.microsoft.com/.default",
  });
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`teams_graph_token_failed status=${resp.status} body=${txt.slice(0, 300)}`);
  }
  const json = (await resp.json()) as { access_token?: string; expires_in?: number };
  const token = String(json.access_token ?? "");
  if (!token) throw new Error("teams_graph_token_empty");
  const expiresIn = Number(json.expires_in ?? 3600);
  cachedToken = { token, expiresAt: Date.now() + expiresIn * 1000, key };
  return token;
}

export async function graphAppFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = await getAppGraphToken();
  return fetch(`https://graph.microsoft.com/v1.0${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}
