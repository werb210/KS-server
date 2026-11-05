// KS_EMAIL_SUBSCRIPTION_TYPES_v1 - the public "choose which emails you get" page linked from every marketing email.
//   GET  /api/public/email-preferences/:token   the page
//   POST /api/public/email-preferences/:token   save (form post), then show the page again with "Saved"
// The token is the contact id signed with the brokerage's secret, so the link works without signing in.
import { Router } from "express";
import express from "express";
import { pool } from "../db.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { brandName } from "../licensee/brand.js";
import { choicesFor, contactFromToken, saveChoices, type PersonChoices } from "../marketing/subscriptionTypes.js";

const router = Router();
router.use(express.urlencoded({ extended: false, limit: "20kb" }));

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function renderPreferencesPage(p: PersonChoices | null, opts: { saved?: boolean; brand: string }): string {
  const head = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Email preferences · ${esc(opts.brand)}</title>
<style>
body{margin:0;background:#f3f4f6;color:#111827;font:16px/1.5 -apple-system,Segoe UI,Roboto,Arial,sans-serif}
main{max-width:560px;margin:32px auto;padding:24px;background:#fff;border-radius:12px;border:1px solid #d1d5db}
h1{font-size:22px;margin:0 0 8px}p{margin:0 0 16px;color:#374151}
label{display:flex;gap:12px;align-items:flex-start;padding:12px 0;border-top:1px solid #e5e7eb;cursor:pointer}
label input{width:20px;height:20px;margin-top:2px;flex:none}label span small{display:block;color:#4b5563;font-size:14px}
.all{border-top:2px solid #d1d5db;margin-top:8px}
button{margin-top:16px;padding:12px 20px;font-size:16px;font-weight:600;color:#fff;background:#1d4ed8;border:0;border-radius:8px;cursor:pointer}
.saved{padding:10px 12px;border-radius:8px;background:#dcfce7;color:#14532d;margin-bottom:16px}
</style></head><body><main>`;
  if (!p) return `${head}<h1>This link has expired</h1><p>Open the link in a newer email from ${esc(opts.brand)}, or reply to that email and ask us to update your preferences.</p></main></body></html>`;
  const hello = p.contact.first_name ? `Hi ${esc(p.contact.first_name)}, choose` : "Choose";
  const rows = p.types.map((t) => `<label><input type="checkbox" name="subscribed" value="${esc(t.id)}"${t.subscribed ? " checked" : ""}>
<span>${esc(t.name)}${t.description ? `<small>${esc(t.description)}</small>` : ""}</span></label>`).join("\n");
  return `${head}<h1>Email preferences</h1>
${opts.saved ? '<div class="saved" role="status">Saved. Your choices apply to our next email.</div>' : ""}
<p>${hello} which emails you get from ${esc(opts.brand)}${p.contact.email ? ` at ${esc(p.contact.email)}` : ""}. Emails about your own application are always sent.</p>
<form method="post">
${rows}
<label class="all"><input type="checkbox" name="all_off" value="1"${p.allOff ? " checked" : ""}>
<span>Unsubscribe from all marketing emails<small>You will still get emails about your own application.</small></span></label>
<button type="submit">Save my choices</button>
</form></main></body></html>`;
}

function send(res: any, html: string, status = 200) {
  res.status(status).set("Content-Type", "text/html; charset=utf-8").set("Cache-Control", "no-store").send(html);
}

router.get("/:token", safeHandler(async (req: any, res: any) => {
  const id = contactFromToken(String(req.params.token ?? ""));
  const p = id ? await choicesFor(pool as any, id) : null;
  send(res, renderPreferencesPage(p, { brand: brandName() }), p ? 200 : 404);
}));

router.post("/:token", safeHandler(async (req: any, res: any) => {
  const id = contactFromToken(String(req.params.token ?? ""));
  const p = id ? await saveChoices(pool as any, id, req.body ?? {}) : null;
  send(res, renderPreferencesPage(p, { brand: brandName(), saved: Boolean(p) }), p ? 200 : 404);
}));

export default router;
