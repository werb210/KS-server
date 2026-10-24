// KS_SERVER_v14_BRAND_FONT - background colour and font in the licensee's branding, and on the public pages.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { brandTheme, contrastRatio, textOn, warmBrand } from "../licensee/brand.js";
import {
  checkField, clearLicenseeCache, envDefaults, LICENSEE_FIELDS, publicLicensee, resetLastLoadedLicensee, updateLicenseeSettings,
} from "../licensee/settings.js";
import { page } from "../routes/libraryPublic.js";
import { joinPageHtml } from "../routes/meetings.js";

function dbWith(row: Record<string, unknown> | null) {
  const query = vi.fn(async (sql: string) => {
    if (/FROM licensee_settings/.test(sql)) return { rows: row ? [row] : [] };
    return { rows: [] };
  });
  return { query };
}

beforeEach(() => {
  clearLicenseeCache();
  resetLastLoadedLicensee();
});
afterEach(() => {
  delete process.env.KS_BACKGROUND_COLOR;
  delete process.env.KS_FONT_FAMILY;
  clearLicenseeCache();
  resetLastLoadedLicensee();
});

describe("settings", () => {
  it("has background_color and font_family next to the colours, empty by default", () => {
    expect(LICENSEE_FIELDS).toEqual(expect.arrayContaining(["primary_color", "accent_color", "background_color", "font_family"]));
    const d = envDefaults({});
    expect(d.background_color).toBe("");
    expect(d.font_family).toBe("");
    expect(envDefaults({ KS_BACKGROUND_COLOR: "#FFFAF0", KS_FONT_FAMILY: "Lato" })).toMatchObject({ background_color: "#FFFAF0", font_family: "Lato" });
  });

  it("checks them", () => {
    expect(checkField("background_color", "#fffaf0")).toEqual({ ok: true, value: "#fffaf0" });
    expect(checkField("background_color", "beige")).toMatchObject({ ok: false });
    expect(checkField("font_family", "  Source   Sans 3 ")).toEqual({ ok: true, value: "Source Sans 3" });
    for (const bad of ["Lato;}body{display:none", "url(x)", "<b>", "x".repeat(61), "'Lato'"]) {
      expect(checkField("font_family", bad), bad).toMatchObject({ ok: false });
    }
    expect(checkField("font_family", "")).toEqual({ ok: true, value: "" });
  });

  it("saves them through PUT /api/licensee's path and shows them to the apps", async () => {
    const db = dbWith({ company_name: "Prairie Capital", background_color: "#FFFAF0", font_family: "Lato" });
    const r = await updateLicenseeSettings(db, { background_color: "#FFFAF0", font_family: "Lato" }, "u-1");
    expect(r.ok).toBe(true);
    const insert = db.query.mock.calls.find(([sql]) => /INSERT INTO licensee_settings/.test(sql))!;
    expect(insert[0]).toMatch(/background_color/);
    expect(insert[0]).toMatch(/font_family/);
    const pub = await publicLicensee(db);
    expect(pub).toMatchObject({ background_color: "#FFFAF0", font_family: "Lato" });
  });
});

describe("brand theme on the public pages", () => {
  it("keeps text readable whatever the colours", () => {
    expect(contrastRatio("#FFFFFF", "#000000")).toBeCloseTo(21, 0);
    expect(textOn("#0B1F3A")).toBe("#FFFFFF");
    expect(textOn("#F5D547")).toBe("#0F172A");
    const light = brandTheme({ ...envDefaults({}), primary_color: "#F5D547" });
    expect(light.primaryText).toBe("#0F172A");
    expect(light.brandText).toBe("#0F172A"); // too light to read on white
    expect(contrastRatio(light.primary, light.primaryText)).toBeGreaterThanOrEqual(4.5);
    const dark = brandTheme({ ...envDefaults({}), primary_color: "#7A1F3D" });
    expect(dark).toMatchObject({ primary: "#7A1F3D", primaryText: "#FFFFFF", brandText: "#7A1F3D" });
  });

  it("loads the licensee's font and uses its background", async () => {
    await warmBrand(dbWith({ company_name: "Prairie Capital", primary_color: "#7A1F3D", background_color: "#FFFAF0", font_family: "Open Sans" }));
    const html = page("Shared file", "<h1>x</h1>");
    expect(html).toContain('href="https://fonts.googleapis.com/css2?family=Open+Sans:wght@400;600;700&amp;display=swap"');
    expect(html).toContain('font:16px/1.5 "Open Sans", -apple-system');
    expect(html).toContain("background:#FFFAF0");
    expect(html).toContain("background:#7A1F3D;color:#FFFFFF");
    const join = joinPageHtml(null);
    expect(join).toContain('font-family:"Open Sans"');
    expect(join).toContain("background:#FFFAF0");
  });

  it("without a font or background, the pages look as before (system font, light grey)", async () => {
    await warmBrand(dbWith({ company_name: "Prairie Capital" }));
    const html = page("Shared file", "");
    expect(html).not.toContain("fonts.googleapis.com");
    expect(html).toContain("font:16px/1.5 -apple-system, Segoe UI, Roboto, Arial, sans-serif");
    expect(html).toContain("background:#F1F5F9");
    expect(brandTheme({ ...envDefaults({}), font_family: "Arial" }).fontLink).toBe("");
  });
});
