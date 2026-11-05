// KS_CLIENT_LANGUAGES_v1 - PUT /api/client/language { language }: the signed-in client's language.
// The client is identified by the mobile number in their sign-in token, exactly as the ownership checks do.
import { Router } from "express";
import { pool } from "../db.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { getLicenseeSettings } from "../licensee/settings.js";
import { asLang, offers, setLanguageForPhone } from "./language.js";

export async function clientPhone(req: any): Promise<string | null> {
  const h = req.headers?.authorization;
  const secret = process.env.JWT_SECRET;
  if (typeof h !== "string" || !h.startsWith("Bearer ") || !secret) return null;
  try {
    const jwt = (await import("jsonwebtoken")).default;
    const d = jwt.verify(h.slice(7), secret, { algorithms: ["HS256"] }) as Record<string, unknown>;
    const p = String(typeof d.phone === "string" ? d.phone : "").replace(/\D/g, "");
    return p.length >= 10 ? p : null;
  } catch { return null; }
}

const router = Router();

router.put("/language", safeHandler(async (req: any, res: any) => {
  const phone = await clientPhone(req);
  if (!phone) return res.status(401).json({ error: "unauthorized" });
  const l = asLang(req.body?.language);
  if (!l) return res.status(400).json({ error: "language must be en, fr or es" });
  const settings = await getLicenseeSettings(pool as any);
  if (!offers(String((settings as any).client_languages ?? "en"), l)) return res.status(400).json({ error: "language_not_offered" });
  const updated = await setLanguageForPhone(pool as any, phone, l);
  res.json({ ok: true, language: l, updated });
}));

export default router;
