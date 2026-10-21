// KS_SERVER_v1_LICENSEE - this copy's addresses and branding come from its own settings, never Boreal's.
import { afterEach, describe, expect, it } from "vitest";
import { clientUrl, hostOf, licenseeOrigins, portalUrl, serverUrl, websiteUrl } from "../licensee/urls.js";
import { checkField, envDefaults } from "../licensee/settings.js";

const NAMES = ["KS_SERVER_URL", "PUBLIC_BASE_URL", "PUBLIC_SERVER_URL", "SERVER_PUBLIC_URL", "SERVER_URL", "KS_CLIENT_URL",
  "CLIENT_URL", "CLIENT_BASE_URL", "CLIENT_APP_URL", "CLIENT_PORTAL_URL", "KS_PORTAL_URL", "PORTAL_URL", "KS_WEBSITE_URL",
  "WEBSITE_URL", "BF_WEBSITE_URL", "KS_COMPANY_NAME", "KS_PRIMARY_COLOR"];
const saved: Record<string, string | undefined> = {};
for (const n of NAMES) saved[n] = process.env[n];
afterEach(() => { for (const n of NAMES) { if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n]; } });
const clear = () => { for (const n of NAMES) delete process.env[n]; };

describe("licensee addresses", () => {
  it("fall back to the development copy, never Boreal", () => {
    clear();
    for (const u of [serverUrl(), clientUrl(), portalUrl(), websiteUrl(), ...licenseeOrigins()]) {
      expect(u).not.toMatch(/boreal/i);
      expect(u).toMatch(/^https:\/\//);
    }
    expect(serverUrl()).toContain("ks-server-dev");
    expect(websiteUrl()).toBe(clientUrl());
  });

  it("use this copy's settings first, and ignore values that are not web addresses", () => {
    clear();
    process.env.KS_CLIENT_URL = "https://apply.example-brokerage.ca/";
    process.env.PORTAL_URL = "not a url";
    process.env.KS_PORTAL_URL = "https://staff.example-brokerage.ca";
    expect(clientUrl()).toBe("https://apply.example-brokerage.ca");
    expect(portalUrl()).toBe("https://staff.example-brokerage.ca");
    expect(hostOf(clientUrl())).toBe("apply.example-brokerage.ca");
  });
});

describe("licensee settings", () => {
  it("defaults are neutral and the KS_* settings override them", () => {
    clear();
    expect(envDefaults({}).company_name).toBe("Keystone Demo Brokerage");
    const d = envDefaults({ KS_COMPANY_NAME: "Prairie Capital", KS_PRIMARY_COLOR: "#112233" });
    expect(d.company_name).toBe("Prairie Capital");
    expect(d.primary_color).toBe("#112233");
  });

  it("checks each field", () => {
    expect(checkField("primary_color", "blue")).toMatchObject({ ok: false });
    expect(checkField("primary_color", "#0b1f3a")).toEqual({ ok: true, value: "#0b1f3a" });
    expect(checkField("logo_url", "http://x.ca/logo.png")).toMatchObject({ ok: false });
    expect(checkField("support_email", "help@")).toMatchObject({ ok: false });
    expect(checkField("country", "us")).toEqual({ ok: true, value: "US" });
    expect(checkField("company_name", "x".repeat(201))).toMatchObject({ ok: false });
    expect(checkField("legal_name", "")).toEqual({ ok: true, value: "" });
  });
});
