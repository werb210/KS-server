// BF_SERVER_O365_VISIBILITY_v274
// Office 365 failures are logged with Microsoft's error code and translated
// into explanations that routes and the portal can act on.

export type O365Failure = { stage: string; status?: number | null; code?: string | null; message?: string | null; at: string };

const failures = new Map<string, O365Failure>();

/** Reads Microsoft identity (AADSTS...) and Graph error bodies. Never returns tokens. */
export function parseMicrosoftError(text: string): { code: string | null; message: string | null } {
  let code: string | null = null;
  let message: string | null = null;
  try {
    const body = JSON.parse(text);
    if (body?.error && typeof body.error === "object") {
      code = body.error.code ?? null;
      message = body.error.message ?? null;
    } else {
      code = typeof body?.error === "string" ? body.error : null;
      message = typeof body?.error_description === "string" ? body.error_description : null;
    }
  } catch {
    message = text ? text.slice(0, 300) : null;
  }
  const aad = String(message ?? "").match(/AADSTS\d+/);
  if (aad) code = aad[0];
  return { code, message: message ? String(message).split(/\r?\n/)[0].slice(0, 300) : null };
}

export function recordO365Failure(userId: string | null, failure: Omit<O365Failure, "at">): O365Failure {
  const entry: O365Failure = { ...failure, at: new Date().toISOString() };
  if (userId) failures.set(userId, entry);
  console.error(JSON.stringify({ event: "o365_failure", userId, ...entry }));
  return entry;
}

export function lastO365Failure(userId: string): O365Failure | null {
  return failures.get(userId) ?? null;
}

export function clearO365Failure(userId: string): void {
  failures.delete(userId);
}

export function explainO365Failure(f: O365Failure | null): string {
  if (!f) return "Office 365 could not be reached.";
  const code = String(f.code ?? "");
  if (f.stage === "not_configured") return "Microsoft 365 is not connected for your company yet. An administrator connects it once in Settings > Connections."; // KS_SERVER_M365_ONE_CLICK
  if (f.stage === "no_refresh_token") return "Your Office 365 connection has expired and cannot renew itself. Reconnect Office 365.";
  if (/^AADSTS7000215$|^AADSTS7000222$|^AADSTS7000218$/.test(code)) return "The Microsoft app key on this server is wrong or has expired. Keystone support renews it; nothing is needed from you.";
  if (/^AADSTS65001$/.test(code) || code === "consent_required") return "Microsoft 365 needs your administrator's approval again. An administrator clicks Reconnect in Settings > Connections, then you reconnect Office 365.";
  if (/^AADSTS(700082|70008|50173|50076|50079|9002313|700084)$/.test(code) || code === "invalid_grant" || code === "interaction_required") return "Your Microsoft sign-in is no longer valid (expired, password changed, or MFA required). Reconnect Office 365.";
  if (f.status === 401 || code === "InvalidAuthenticationToken") return "Office 365 rejected the saved sign-in. Reconnect Office 365.";
  if (f.status === 403 || code === "ErrorAccessDenied" || code === "Authorization_RequestDenied") return "The Office 365 connection does not have permission for this mailbox or calendar. Reconnect Office 365 and accept all requested permissions.";
  return `Office 365 returned an error${f.status ? ` (${f.status})` : ""}${code ? `: ${code}` : ""}.`;
}
