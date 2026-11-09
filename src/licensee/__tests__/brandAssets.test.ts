// KS_SERVER_BRAND_ASSETS_v1
import { describe, expect, it } from "vitest";
import { checkBrandAsset, storeBrandAsset } from "../brandAssets.js";
import { checkField, LICENSEE_FIELDS, OPS_BRAND_FIELDS } from "../settings.js";

describe("brand asset uploads", () => {
  it("accepts the right image types for each kind", () => {
    expect(checkBrandAsset("logo", "image/png", 1000)).toEqual({ ok: true, ext: ".png" });
    expect(checkBrandAsset("logo", "image/svg+xml", 1000)).toEqual({ ok: true, ext: ".svg" });
    expect(checkBrandAsset("favicon", "image/x-icon", 1000)).toEqual({ ok: true, ext: ".ico" });
    expect(checkBrandAsset("favicon", "image/jpeg", 1000).ok).toBe(false);
    expect(checkBrandAsset("logo", "application/pdf", 1000).ok).toBe(false);
    expect(checkBrandAsset("banner", "image/png", 1000).ok).toBe(false);
  });
  it("refuses empty and oversized files", () => {
    expect(checkBrandAsset("logo", "image/png", 0).ok).toBe(false);
    expect(checkBrandAsset("logo", "image/png", 3 * 1024 * 1024).ok).toBe(false);
  });
  it("stores under the brokerage folder and returns the address", async () => {
    let seen = "";
    const url = await storeBrandAsset("favicon", Buffer.from("png"), "image/png", async (path) => { seen = path; return `https://store.example/brand-assets/${path}`; });
    expect(seen).toMatch(/^brokerage\/favicon-[0-9a-f-]{36}\.png$/);
    expect(url).toBe(`https://store.example/brand-assets/${seen}`);
  });
  it("adds favicon_url as a brand setting that must be https", () => {
    expect(LICENSEE_FIELDS).toContain("favicon_url");
    expect(OPS_BRAND_FIELDS).toContain("favicon_url");
    expect(checkField("favicon_url", "http://x.example/f.png").ok).toBe(false);
    expect(checkField("favicon_url", "https://x.example/f.png")).toEqual({ ok: true, value: "https://x.example/f.png" });
  });
});
