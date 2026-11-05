// KS_LANDING_PAGES_v1 - landing-page builder (HubSpot gaps batch 2).
// A page is an ordered list of blocks (hero, text, image, bullets, button, form). Published pages are served by the
// brokerage's server at /api/public/pages/<slug>. A form block shows one of the brokerage's website-kit forms, so a
// submission becomes a CRM lead exactly like a website form (lead rotation, consent, timeline, staff notified).
import type { KitForm } from "../marketing/websiteKit.js";

type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

export type Block =
  | { type: "hero"; heading: string; text: string; image_url: string; button_text: string; button_link: string }
  | { type: "text"; heading: string; text: string }
  | { type: "image"; url: string; alt: string }
  | { type: "bullets"; heading: string; items: string[] }
  | { type: "button"; text: string; link: string }
  | { type: "form"; form_id: string; heading: string };

export type LandingPage = {
  id: string; slug: string; title: string; description: string | null; status: "draft" | "published";
  blocks: Block[]; views: number; submissions: number; published_at: string | null; updated_at: string;
};

export const MAX_BLOCKS = 30;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class PageError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}

const clip = (v: unknown, n: number) => String(v ?? "").trim().slice(0, n);

/** https images only. */
export function safeImage(v: unknown): string {
  const s = clip(v, 1000);
  return /^https:\/\/[^\s"'<>]+$/i.test(s) ? s : "";
}

/** https, mailto:, tel: or "#form" (jumps to the page's form). */
export function safeLink(v: unknown): string {
  const s = clip(v, 1000);
  if (s === "#form") return s;
  if (/^https:\/\/[^\s"'<>]+$/i.test(s)) return s;
  if (/^mailto:[^\s"'<>]+$/i.test(s) || /^tel:\+?[0-9 ()-]{5,30}$/i.test(s)) return s;
  return "";
}

export function slugify(v: unknown): string {
  return String(v ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

/** Cleans the blocks a person built; unknown block types and empty blocks are dropped. */
export function normalizeBlocks(raw: unknown): Block[] {
  const list = Array.isArray(raw) ? raw.slice(0, MAX_BLOCKS) : [];
  const out: Block[] = [];
  for (const b of list) {
    switch (b?.type) {
      case "hero": {
        const heading = clip(b.heading, 140);
        if (!heading) break;
        out.push({ type: "hero", heading, text: clip(b.text, 600), image_url: safeImage(b.image_url), button_text: clip(b.button_text, 40), button_link: safeLink(b.button_link) });
        break;
      }
      case "text": {
        const text = clip(b.text, 5000);
        if (!text) break;
        out.push({ type: "text", heading: clip(b.heading, 140), text });
        break;
      }
      case "image": {
        const url = safeImage(b.url);
        if (!url) break;
        out.push({ type: "image", url, alt: clip(b.alt, 200) });
        break;
      }
      case "bullets": {
        const items = (Array.isArray(b.items) ? b.items : []).map((x: unknown) => clip(x, 200)).filter(Boolean).slice(0, 12);
        if (!items.length) break;
        out.push({ type: "bullets", heading: clip(b.heading, 140), items });
        break;
      }
      case "button": {
        const text = clip(b.text, 40), link = safeLink(b.link);
        if (!text || !link) break;
        out.push({ type: "button", text, link });
        break;
      }
      case "form": {
        const form_id = clip(b.form_id, 40);
        if (!UUID_RE.test(form_id)) break;
        if (out.some((x) => x.type === "form")) break; // one form per page
        out.push({ type: "form", form_id, heading: clip(b.heading, 140) });
        break;
      }
    }
  }
  return out;
}

const COLS = `id::text AS id, slug, title, description, status, blocks, views, submissions, published_at, updated_at`;
const rowToPage = (r: any): LandingPage => ({ ...r, blocks: normalizeBlocks(r.blocks), views: Number(r.views ?? 0), submissions: Number(r.submissions ?? 0) });

export async function listPages(db: Q, silo: string): Promise<LandingPage[]> {
  const { rows } = await db.query(`SELECT ${COLS} FROM landing_pages WHERE silo = $1 ORDER BY updated_at DESC`, [silo]);
  return rows.map(rowToPage);
}

export async function getPage(db: Q, silo: string, id: string): Promise<LandingPage | null> {
  if (!UUID_RE.test(id)) return null;
  const { rows } = await db.query(`SELECT ${COLS} FROM landing_pages WHERE id = $1::uuid AND silo = $2`, [id, silo]);
  return rows[0] ? rowToPage(rows[0]) : null;
}

export async function publishedBySlug(db: Q, slug: string): Promise<(LandingPage & { silo: string }) | null> {
  const { rows } = await db.query(`SELECT ${COLS}, silo FROM landing_pages WHERE slug = $1 AND status = 'published' LIMIT 1`, [slugify(slug)]);
  return rows[0] ? (rowToPage(rows[0]) as LandingPage & { silo: string }) : null;
}

/** Creates (no id) or updates a page. Slugs are unique per brokerage. */
export async function savePage(db: Q, silo: string, input: Record<string, unknown>, actor: string | null, id?: string): Promise<LandingPage> {
  const title = clip(input.title, 140);
  if (!title) throw new PageError("title_required", "Give the page a title.");
  const slug = slugify(input.slug || title);
  if (slug.length < 2) throw new PageError("slug_required", "Give the page a web address (letters and numbers).");
  const status = input.status === "published" ? "published" : "draft";
  const blocks = normalizeBlocks(input.blocks);
  const description = clip(input.description, 300) || null;
  const taken = await db.query(`SELECT id::text AS id FROM landing_pages WHERE slug = $1 AND ($2::uuid IS NULL OR id <> $2::uuid) LIMIT 1`, [slug, id ?? null]);
  if (taken.rows[0]) throw new PageError("slug_taken", "Another page already uses that web address.", 409);
  if (id) {
    if (!UUID_RE.test(id)) throw new PageError("not_found", "Page not found.", 404);
    const { rows } = await db.query(
      `UPDATE landing_pages SET title = $3, slug = $4, description = $5, status = $6, blocks = $7::jsonb,
              published_at = CASE WHEN $6 = 'published' THEN COALESCE(published_at, now()) ELSE published_at END, updated_at = now()
        WHERE id = $1::uuid AND silo = $2 RETURNING ${COLS}`,
      [id, silo, title, slug, description, status, JSON.stringify(blocks)],
    );
    if (!rows[0]) throw new PageError("not_found", "Page not found.", 404);
    return rowToPage(rows[0]);
  }
  const { rows } = await db.query(
    `INSERT INTO landing_pages (silo, title, slug, description, status, blocks, created_by, published_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::uuid, CASE WHEN $5 = 'published' THEN now() END) RETURNING ${COLS}`,
    [silo, title, slug, description, status, JSON.stringify(blocks), actor],
  );
  return rowToPage(rows[0]);
}

export async function deletePage(db: Q, silo: string, id: string): Promise<boolean> {
  if (!UUID_RE.test(id)) return false;
  const r = await db.query(`DELETE FROM landing_pages WHERE id = $1::uuid AND silo = $2 RETURNING id`, [id, silo]);
  return (r.rowCount ?? r.rows.length) > 0;
}

// ---- Rendering ---------------------------------------------------------------------------------------------

export function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const paragraphs = (t: string) => t.split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join("");

/** A readable accent colour: the brand colour when it is a hex colour dark enough for white text, else navy. */
export function accentColour(hex: unknown): string {
  const m = /^#([0-9a-f]{6})$/i.exec(String(hex ?? "").trim());
  if (!m) return "#0B1F3A";
  const n = parseInt(m[1]!, 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  const lum = 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  return (1.05) / (lum + 0.05) >= 4.5 ? `#${m[1]}` : "#0B1F3A";
}

export type RenderContext = {
  brand: string; colour: string; logoUrl: string; formAction: (formId: string) => string;
  forms: Map<string, KitForm>; notice?: { formId: string; ok: boolean; message: string } | null; preview?: boolean;
};

function renderForm(b: Extract<Block, { type: "form" }>, ctx: RenderContext): string {
  const form = ctx.forms.get(b.form_id);
  if (!form) return ctx.preview ? `<section class="blk"><p class="muted">This form is paused or was deleted. Choose another form.</p></section>` : "";
  const notice = ctx.notice && ctx.notice.formId === form.id
    ? `<div class="${ctx.notice.ok ? "ok" : "err"}" role="${ctx.notice.ok ? "status" : "alert"}">${esc(ctx.notice.message)}</div>` : "";
  if (ctx.notice?.ok && ctx.notice.formId === form.id) return `<section class="blk" id="form">${b.heading ? `<h2>${esc(b.heading)}</h2>` : ""}${notice}</section>`;
  const fields = form.fields.map((f) => {
    const id = `f-${f.key}`;
    const type = f.key === "email" ? "email" : f.key === "phone" ? "tel" : "text";
    const input = f.key === "message"
      ? `<textarea id="${id}" name="${f.key}" rows="4"${f.required ? " required" : ""}></textarea>`
      : `<input id="${id}" name="${f.key}" type="${type}"${f.required ? " required" : ""} autocomplete="${f.key === "full_name" ? "name" : f.key === "company" ? "organization" : f.key === "phone" ? "tel" : f.key === "email" ? "email" : "off"}">`;
    return `<label for="${id}">${esc(f.label)}${f.required ? "" : ' <span class="muted">(optional)</span>'}</label>${input}`;
  }).join("");
  const consentText = `Yes, ${ctx.brand} may send me emails and texts about financing. I can unsubscribe at any time.`;
  return `<section class="blk" id="form">${b.heading ? `<h2>${esc(b.heading)}</h2>` : ""}${notice}
<form method="post" action="${esc(ctx.formAction(form.id))}">
${fields}
<input type="hidden" name="consentText" value="${esc(consentText)}">
<label class="check"><input type="checkbox" name="consent" value="1"> <span>${esc(consentText)}</span></label>
<div class="hp" aria-hidden="true"><label>Leave this empty<input name="company_website" tabindex="-1" autocomplete="off"></label></div>
<button type="submit">${esc(form.button_label || "Send")}</button>
</form></section>`;
}

export function renderPage(page: Pick<LandingPage, "title" | "description" | "blocks">, ctx: RenderContext): string {
  const c = ctx.colour;
  const blocks = page.blocks.map((b) => {
    switch (b.type) {
      case "hero":
        return `<header class="hero">${b.image_url ? `<img src="${esc(b.image_url)}" alt="">` : ""}<h1>${esc(b.heading)}</h1>${b.text ? `<p class="lead">${esc(b.text)}</p>` : ""}${b.button_text && b.button_link ? `<a class="btn" href="${esc(b.button_link)}">${esc(b.button_text)}</a>` : ""}</header>`;
      case "text":
        return `<section class="blk">${b.heading ? `<h2>${esc(b.heading)}</h2>` : ""}${paragraphs(b.text)}</section>`;
      case "image":
        return `<section class="blk"><img class="full" src="${esc(b.url)}" alt="${esc(b.alt)}"></section>`;
      case "bullets":
        return `<section class="blk">${b.heading ? `<h2>${esc(b.heading)}</h2>` : ""}<ul>${b.items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul></section>`;
      case "button":
        return `<section class="blk center"><a class="btn" href="${esc(b.link)}">${esc(b.text)}</a></section>`;
      case "form":
        return renderForm(b, ctx);
    }
  }).join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(page.title)} · ${esc(ctx.brand)}</title>${page.description ? `<meta name="description" content="${esc(page.description)}">` : ""}
${ctx.preview ? '<meta name="robots" content="noindex">' : ""}
<style>
*{box-sizing:border-box}body{margin:0;background:#f9fafb;color:#111827;font:17px/1.6 -apple-system,Segoe UI,Roboto,Arial,sans-serif}
.top{background:#fff;border-bottom:1px solid #e5e7eb;padding:14px 20px;font-weight:700;color:#111827}.top img{height:36px;vertical-align:middle}
main{max-width:760px;margin:0 auto;padding:0 20px 48px}
.hero{padding:40px 0 24px;text-align:center}.hero img{max-width:100%;border-radius:12px;margin-bottom:20px}
h1{font-size:34px;line-height:1.2;margin:0 0 12px}h2{font-size:24px;margin:0 0 10px}.lead{font-size:19px;color:#374151;margin:0 0 20px}
.blk{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:24px;margin:16px 0}.blk p{margin:0 0 12px;color:#1f2937}
.center{text-align:center}.full{width:100%;border-radius:8px;display:block}ul{margin:0;padding-left:22px}li{margin:6px 0}
.btn,button{display:inline-block;background:${c};color:#fff;border:0;border-radius:8px;padding:14px 22px;font-size:17px;font-weight:600;text-decoration:none;cursor:pointer}
label{display:block;font-weight:600;margin:14px 0 6px;color:#111827}input,textarea{width:100%;padding:11px 12px;font-size:16px;border:1px solid #9ca3af;border-radius:8px;color:#111827;background:#fff}
label.check{display:flex;gap:10px;font-weight:400;align-items:flex-start}label.check input{width:20px;height:20px;flex:none;margin-top:3px}
form button{margin-top:18px}.muted{color:#4b5563;font-weight:400}.hp{position:absolute;left:-9999px}
.ok{background:#dcfce7;color:#14532d;padding:12px;border-radius:8px}.err{background:#fee2e2;color:#7f1d1d;padding:12px;border-radius:8px;margin-bottom:8px}
footer{text-align:center;color:#4b5563;font-size:14px;padding:24px}
</style></head><body>
<div class="top">${ctx.logoUrl ? `<img src="${esc(ctx.logoUrl)}" alt="${esc(ctx.brand)}">` : esc(ctx.brand)}</div>
<main>${blocks || (ctx.preview ? '<section class="blk"><p class="muted">Add a block to start building this page.</p></section>' : "")}</main>
<footer>© ${new Date().getFullYear()} ${esc(ctx.brand)}</footer>
</body></html>`;
}
