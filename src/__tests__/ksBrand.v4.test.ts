// KS_SERVER_v4_BRANDING - the synchronous brand accessor and the "no Boreal in src/" guard.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assistantName, brandName, brandSettings, contactLine, legalName, signnowFromEmail, startBrandRefresh,
  supportEmail, supportPhone, warmBrand, winAnsi,
} from "../licensee/brand.js";
import { clearLicenseeCache, resetLastLoadedLicensee, updateLicenseeSettings } from "../licensee/settings.js";
// @ts-expect-error - plain .mjs script without type declarations
import { brandHits, scanRepo, stringLiterals } from "../../scripts/check-brand-strings.mjs";

const KS_VARS = ["KS_COMPANY_NAME", "KS_LEGAL_NAME", "KS_ASSISTANT_NAME", "KS_SUPPORT_EMAIL", "KS_SUPPORT_PHONE", "SIGNNOW_FROM_EMAIL"];

function dbWith(row: Record<string, unknown> | null) {
  const query = vi.fn(async (sql: string) => {
    if (/FROM licensee_settings/.test(sql)) return { rows: row ? [row] : [] };
    return { rows: [] };
  });
  return { query };
}

let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = Object.fromEntries(KS_VARS.map((k) => [k, process.env[k]]));
  for (const k of KS_VARS) delete process.env[k];
  clearLicenseeCache();
  resetLastLoadedLicensee();
});
afterEach(() => {
  for (const k of KS_VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  clearLicenseeCache();
  resetLastLoadedLicensee();
});

describe("brand accessor", () => {
  it("uses neutral defaults before anything is loaded", () => {
    expect(brandName()).toBe("Keystone Demo Brokerage");
    expect(legalName()).toBe("Keystone Demo Brokerage"); // falls back to the trading name
    expect(assistantName()).toBe("Assistant");
    expect(supportEmail()).toBe("");
    expect(contactLine()).toBe("");
  });

  it("uses the KS_* settings before the database is read", () => {
    process.env.KS_COMPANY_NAME = "Acme Capital";
    process.env.KS_ASSISTANT_NAME = "Ada";
    process.env.KS_SUPPORT_EMAIL = "help@acme.example";
    expect(brandName()).toBe("Acme Capital");
    expect(assistantName()).toBe("Ada");
    expect(contactLine()).toBe("email help@acme.example");
  });

  it("returns what getLicenseeSettings last loaded, over the KS_* settings", async () => {
    process.env.KS_COMPANY_NAME = "Env Name";
    await warmBrand(dbWith({ company_name: "Saved Lending", legal_name: "Saved Lending Ltd.", assistant_name: "Sam", support_email: "hi@saved.example", support_phone: "+1 403 555 0100" }));
    expect(brandName()).toBe("Saved Lending");
    expect(legalName()).toBe("Saved Lending Ltd.");
    expect(assistantName()).toBe("Sam");
    expect(supportEmail()).toBe("hi@saved.example");
    expect(supportPhone()).toBe("+1 403 555 0100");
    expect(contactLine()).toBe("call +1 403 555 0100 or email hi@saved.example");
    expect(brandSettings().company_name).toBe("Saved Lending");
  });

  it("an empty saved value falls back to the KS_* setting", async () => {
    process.env.KS_COMPANY_NAME = "Env Name";
    await warmBrand(dbWith({ company_name: "  ", assistant_name: "" }));
    expect(brandName()).toBe("Env Name");
    expect(assistantName()).toBe("Assistant");
  });

  it("picks up a save through PUT /api/licensee straight away", async () => {
    const row: Record<string, unknown> = { company_name: "Before" };
    const db = { query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (/INSERT INTO licensee_settings/.test(sql)) { row.company_name = (params ?? [])[1]; return { rows: [] }; }
      if (/FROM licensee_settings/.test(sql)) return { rows: [row] };
      return { rows: [] };
    }) };
    await warmBrand(db);
    expect(brandName()).toBe("Before");
    const r = await updateLicenseeSettings(db, { company_name: "After" }, "admin-1");
    expect(r.ok).toBe(true);
    expect(brandName()).toBe("After");
  });

  it("keeps the previous values when the database cannot be read", async () => {
    await warmBrand(dbWith({ company_name: "Loaded Once" }));
    clearLicenseeCache();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await warmBrand({ query: async () => { throw new Error("db down"); } });
    expect(brandName()).toBe("Loaded Once");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("startBrandRefresh loads now and again on its interval", async () => {
    vi.useFakeTimers();
    try {
      const db = dbWith({ company_name: "First" });
      const refresh = startBrandRefresh(db, 60_000);
      await refresh.ready;
      expect(brandName()).toBe("First");
      db.query.mockImplementation(async () => ({ rows: [{ company_name: "Second" }] }));
      clearLicenseeCache();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(brandName()).toBe("Second");
      refresh.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("SignNow sender: SIGNNOW_FROM_EMAIL, else the support email - never a Boreal address", async () => {
    expect(signnowFromEmail()).toBe("");
    await warmBrand(dbWith({ support_email: "ops@acme.example" }));
    expect(signnowFromEmail()).toBe("ops@acme.example");
    process.env.SIGNNOW_FROM_EMAIL = "sign@acme.example";
    expect(signnowFromEmail()).toBe("sign@acme.example");
  });

  it("winAnsi keeps PDF text drawable", () => {
    expect(winAnsi("Acme “Capital” – Café 中")).toBe("Acme \"Capital\" - Café ");
  });
});

describe("no Boreal branding in src/ string literals (scripts/check-brand-strings.mjs)", () => {
  it("finds text in quoted strings and template literals, not in comments, identifiers or regexes", () => {
    const src = [
      "// Boreal Financial wrote this",
      "const borealPct = 1; /* Boreal */",
      "const re = /@boreal\\.financial$/i;",
      "send(`Hi from ${name} at Boreal Financial`);",
      "send('2630108 Alberta Ltd.');",
      "send(\"450 Sparling Crt SW\");",
      "send(\"info@boreal.financial\");",
      "send(\"Acme\");",
    ].join("\n");
    expect(stringLiterals(src)).toContain(" at Boreal Financial");
    expect(brandHits(src)).toEqual([" at Boreal Financial", "2630108 Alberta Ltd.", "450 Sparling Crt SW", "info@boreal.financial"]);
    expect(brandHits(src, ["Boreal Financial", "2630108", "Sparling", "info@"])).toEqual([]);
  });

  it("src/ has none outside the allow-list", () => {
    expect(scanRepo(process.cwd())).toEqual([]);
  }, 60_000); // parses every source file
});
