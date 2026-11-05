// KS_LANDING_PAGES_v1 - published landing pages, served by the brokerage's server.
//   GET  /api/public/pages/:slug                   the page
//   POST /api/public/pages/:slug/forms/:formId     a form on the page (plain form post) -> a CRM lead, then the page again
import express, { Router } from "express";
import rateLimit from "express-rate-limit";
import { rateLimitKeyFromRequest } from "../middleware/clientIp.js";
import { pool } from "../db.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { brandName, brandSettings } from "../licensee/brand.js";
import { serverUrl } from "../licensee/urls.js";
import { logWarnSwallowed } from "../lib/logWarnSwallowed.js";
import { listForms, liveForms, parseSubmission, type KitForm } from "../marketing/websiteKit.js";
import { accentColour, publishedBySlug, renderPage, slugify, type LandingPage } from "../landingPages/pages.js";

const router = Router();
router.use(express.urlencoded({ extended: false, limit: "32kb" }));
const submitLimiter = rateLimit({ windowMs: 10 * 60_000, limit: 10, standardHeaders: true, legacyHeaders: false, keyGenerator: rateLimitKeyFromRequest });

/** Pages show https images from anywhere, inline styles, and post forms only to this server. No scripts. */
export const PAGE_CSP = "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

export function pageUrl(slug: string): string {
  return `${serverUrl().replace(/\/+$/, "")}/api/public/pages/${slugify(slug)}`;
}

async function formsFor(page: LandingPage): Promise<Map<string, KitForm>> {
  const ids = new Set(page.blocks.filter((b) => b.type === "form").map((b) => (b as { form_id: string }).form_id));
  if (!ids.size) return new Map();
  const { formLimit } = await import("./websiteKit.js");
  const lim = await formLimit();
  return new Map(liveForms(await listForms(pool as any), lim.limit).filter((f) => ids.has(f.id)).map((f) => [f.id, f]));
}

function send(res: any, html: string, status = 200) {
  res.status(status).set("Content-Type", "text/html; charset=utf-8").set("Content-Security-Policy", PAGE_CSP)
    .set("Cache-Control", "no-store").send(html);
}

const NOT_FOUND = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Page not found</title></head>
<body style="font:17px/1.6 Arial,sans-serif;color:#111827;background:#fff;max-width:560px;margin:48px auto;padding:0 20px"><h1>Page not found</h1><p>This page is not available.</p></body></html>`;

async function show(req: any, res: any, notice: { formId: string; ok: boolean; message: string } | null = null, status = 200) {
  const page = await publishedBySlug(pool as any, String(req.params.slug ?? ""));
  if (!page) return send(res, NOT_FOUND, 404);
  const brand = brandSettings() as any;
  const html = renderPage(page, {
    brand: brandName(), colour: accentColour(brand.primary_color), logoUrl: /^https:\/\//i.test(String(brand.logo_url ?? "")) ? String(brand.logo_url) : "",
    forms: await formsFor(page), notice,
    formAction: (formId) => `/api/public/pages/${encodeURIComponent(page.slug)}/forms/${encodeURIComponent(formId)}#form`,
  });
  if (!notice) {
    void pool.query(`UPDATE landing_pages SET views = views + 1 WHERE id = $1::uuid`, [page.id])
      .catch((err: unknown) => logWarnSwallowed(err, "routes/landingPagesPublic.ts:views"));
  }
  return send(res, html, status);
}

router.get("/:slug", safeHandler(async (req: any, res: any) => show(req, res)));

router.post("/:slug/forms/:formId", submitLimiter, safeHandler(async (req: any, res: any) => {
  const page = await publishedBySlug(pool as any, String(req.params.slug ?? ""));
  if (!page) return send(res, NOT_FOUND, 404);
  const formId = String(req.params.formId ?? "");
  const body = req.body ?? {};
  const thanks = (f?: KitForm) => ({ formId, ok: true, message: f?.thank_you || "Thanks. We will be in touch soon." });
  if (String(body.company_website ?? "").trim()) return show(req, res, thanks()); // the hidden field people never fill in
  const form = (await formsFor(page)).get(formId);
  if (!form) return show(req, res, { formId, ok: false, message: "This form is not taking submissions right now. Please call or email us instead." }, 404);
  const fields: Record<string, string> = {};
  for (const f of form.fields) fields[f.key] = String(body[f.key] ?? "");
  const parsed = parseSubmission(form, {
    fields, consent: body.consent === "1", consentText: body.consentText, page: pageUrl(page.slug),
  });
  if (!parsed.ok) return show(req, res, { formId, ok: false, message: parsed.error }, 400);
  const { submitKitLead } = await import("../marketing/kitLead.js");
  await submitKitLead(pool as any, form, parsed.value);
  await pool.query(`UPDATE landing_pages SET submissions = submissions + 1 WHERE id = $1::uuid`, [page.id])
    .catch((err: unknown) => logWarnSwallowed(err, "routes/landingPagesPublic.ts:submissions"));
  return show(req, res, thanks(form));
}));

export default router;
