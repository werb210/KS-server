// KS_SERVER_v6_PLANS - plan emails: the upgrade request to Keystone sales, and the trial / storage notices to the
// licensee's admins. Sent through Microsoft Graph when it is configured, else SendGrid's transactional sender.
import { sendViaGraph } from "../services/email/graphSendService.js";
import { sendgridConfigured, sendTransactional } from "../services/sendgridService.js";

export type PlanMail = { to: string[]; subject: string; html: string; text: string };
export type PlanMailer = (mail: PlanMail) => Promise<{ ok: boolean; error?: string }>;

// The vendor's sales inbox, where upgrade requests go - not text shown as the licensee's brand.
const DEFAULT_SALES_EMAIL = "keystone@boreal.financial";

export function salesEmail(env: NodeJS.ProcessEnv = process.env): string {
  return String(env.KS_SALES_EMAIL ?? "").trim() || DEFAULT_SALES_EMAIL;
}

function graphConfigured(): boolean {
  return ["MS_GRAPH_TENANT_ID", "MS_GRAPH_CLIENT_ID", "MS_GRAPH_CLIENT_SECRET", "MS_GRAPH_SEND_AS"]
    .every((k) => String(process.env[k] ?? "").trim() !== "");
}

export const sendPlanMail: PlanMailer = async (mail) => {
  const to = [...new Set(mail.to.map((e) => e.trim().toLowerCase()).filter((e) => e.includes("@")))];
  if (!to.length) return { ok: false, error: "no_recipients" };
  if (graphConfigured()) {
    const r = await sendViaGraph({ to, subject: mail.subject, bodyText: mail.text, bodyHtml: mail.html });
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  }
  if (sendgridConfigured()) {
    let sent = 0;
    let lastError = "";
    for (const addr of to) {
      const r = await sendTransactional({ to: addr, subject: mail.subject, html: mail.html });
      if (r.ok) sent += 1; else lastError = r.error ?? `status ${r.status}`;
    }
    return sent > 0 ? { ok: true } : { ok: false, error: lastError || "send_failed" };
  }
  return { ok: false, error: "email_not_configured" };
};

export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));

/** Paragraphs of plain text as both HTML and text bodies. */
export function bodies(paragraphs: string[]): { html: string; text: string } {
  return {
    html: '<div style="font-family:Arial,sans-serif;font-size:14px;color:#0B1F3A">'
      + paragraphs.map((p) => "<p>" + esc(p).replace(/\n/g, "<br/>") + "</p>").join("") + "</div>",
    text: paragraphs.join("\n\n"),
  };
}
