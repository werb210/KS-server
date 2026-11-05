// KS_SERVER_VENDOR_KEYS - a brokerage's own verification-service keys.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearVendorKeyCacheForTests, loadVendorKeys, saveVendorKeys, VendorKeyError, viewOf } from "../vendorKeys.js";
import { createEnvOverlay } from "../../tenancy/envOverlay.js";
import { runWithTenant } from "../../tenancy/context.js";

function memoryDb() {
  const rows = new Map<string, { key: string; value_enc: string; key_name: string }>();
  return {
    rows,
    async query(sql: string, p: unknown[] = []) {
      if (/^SELECT key, value_enc, key_name FROM vendor_keys/.test(sql)) return { rows: [...rows.values()] };
      if (/^DELETE FROM vendor_keys/.test(sql)) { rows.delete(String(p[0])); return { rows: [] }; }
      if (/^INSERT INTO vendor_keys/.test(sql)) { rows.set(String(p[0]), { key: String(p[0]), value_enc: String(p[1]), key_name: String(p[2]) }); return { rows: [] }; }
      throw new Error("unexpected sql " + sql);
    },
  } as any;
}

const KEY = "a".repeat(64);
let saved: NodeJS.ProcessEnv;
beforeEach(() => { saved = { ...process.env }; process.env.LENDER_CREDENTIALS_ENCRYPTION_KEY = KEY; delete process.env.IPINFO_TOKEN; clearVendorKeyCacheForTests(); });
afterEach(() => { clearVendorKeyCacheForTests(); process.env = saved; });

describe("vendor keys", () => {
  it("stores keys encrypted, shows only the last 4 characters, and removes them", async () => {
    const db = memoryDb();
    const out = await saveVendorKeys(db, { IPINFO_TOKEN: "tok_123456", ONFIDO_REGION: "CA" }, "u1");
    expect(db.rows.get("IPINFO_TOKEN")!.value_enc).not.toContain("tok_123456");
    expect(out.IPINFO_TOKEN).toBe("tok_123456");
    const view = viewOf(out);
    expect(view.find((v) => v.key === "IPINFO_TOKEN")).toMatchObject({ set: true, preview: "••••3456" });
    expect(view.find((v) => v.key === "ONFIDO_REGION")).toMatchObject({ set: true, preview: "ca" });
    const after = await saveVendorKeys(db, { IPINFO_TOKEN: null }, "u1");
    expect(after.IPINFO_TOKEN).toBeUndefined();
  });

  it("refuses unknown names and a bad region", async () => {
    const db = memoryDb();
    await expect(saveVendorKeys(db, { DATABASE_URL: "x" }, null)).rejects.toBeInstanceOf(VendorKeyError);
    await expect(saveVendorKeys(db, { ONFIDO_REGION: "mars" }, null)).rejects.toBeInstanceOf(VendorKeyError);
  });

  it("single-brokerage server: the saved key becomes the process setting", async () => {
    const db = memoryDb();
    await saveVendorKeys(db, { IPINFO_TOKEN: "tok_single" }, null);
    expect(process.env.IPINFO_TOKEN).toBe("tok_single");
    await saveVendorKeys(db, { IPINFO_TOKEN: null }, null);
    expect(process.env.IPINFO_TOKEN).toBeUndefined();
  });

  it("shared server: each brokerage sees only its own key, never Keystone's", async () => {
    const overlay = createEnvOverlay({ IPINFO_TOKEN: "keystone-shared", LENDER_CREDENTIALS_ENCRYPTION_KEY: KEY } as any);
    const a = { code: "alpha", env: { LENDER_CREDENTIALS_ENCRYPTION_KEY: KEY } } as any;
    const b = { code: "beta", env: { LENDER_CREDENTIALS_ENCRYPTION_KEY: KEY } } as any;
    const dbA = memoryDb();
    await runWithTenant(a, () => saveVendorKeys(dbA, { IPINFO_TOKEN: "alpha-key" }, null));
    expect(runWithTenant(a, () => overlay.IPINFO_TOKEN)).toBe("alpha-key");
    expect(runWithTenant(b, () => overlay.IPINFO_TOKEN)).toBeUndefined();
  });
});
