// KS_BROKERAGE_QBO - every brokerage connects its own QuickBooks company through Keystone's one Intuit app.
import { describe, expect, it } from "vitest";
import { qboConfig, qboConfigProblem, qboEnvironment } from "../services/quickbooks/qboConfig.js";
import { unwrapState, wrapState } from "../licensee/oauthBroker.js";

const KEY = "a".repeat(44);
const LICENSEE = "11111111-2222-3333-4444-555555555555";

describe("brokerage QuickBooks through Keystone's Intuit app", () => {
  it("uses Keystone's app and environment when the brokerage has no Intuit app of its own", () => {
    const e = { KS_INTUIT_CLIENT_ID: "ks-id", KS_INTUIT_CLIENT_SECRET: "ks-secret", KS_INTUIT_ENVIRONMENT: "production", QBO_ENVIRONMENT: "sandbox", QBO_TOKEN_ENCRYPTION_KEY: KEY } as any;
    expect(qboConfigProblem(e)).toBeNull();
    const cfg = qboConfig(e)!;
    expect(cfg.clientId).toBe("ks-id");
    expect(cfg.clientSecret).toBe("ks-secret");
    expect(qboEnvironment(e)).toBe("production");
  });

  it("keeps a brokerage's own Intuit app when it has one", () => {
    const e = { QBO_CLIENT_ID: "own", QBO_CLIENT_SECRET: "own-secret", QBO_ENVIRONMENT: "sandbox", KS_INTUIT_CLIENT_ID: "ks-id", KS_INTUIT_CLIENT_SECRET: "ks-secret", KS_INTUIT_ENVIRONMENT: "production", QBO_TOKEN_ENCRYPTION_KEY: KEY } as any;
    const cfg = qboConfig(e)!;
    expect(cfg.clientId).toBe("own");
    expect(cfg.clientSecret).toBe("own-secret");
    expect(qboEnvironment(e)).toBe("sandbox");
  });

  it("names what is missing", () => {
    expect(qboConfigProblem({} as any)).toMatch(/KS_INTUIT_CLIENT_ID/);
  });

  it("sends Intuit to Keystone's redirect broker and round-trips the state", () => {
    const e = { KS_INTUIT_CLIENT_ID: "ks-id", KS_INTUIT_CLIENT_SECRET: "s", QBO_TOKEN_ENCRYPTION_KEY: KEY, KS_OAUTH_BROKER_URL: "https://ops.example.test/api/oauth/callback", KS_LICENSEE_ID: LICENSEE, KS_OPS_KEY: "ops-key" } as any;
    expect(qboConfig(e)!.redirectUri).toBe("https://ops.example.test/api/oauth/callback/intuit");
    const inner = "abcdefghijklmnopqrstuvwxyz012345";
    const wrapped = wrapState("qbo", inner, 600_000, e);
    expect(wrapped.startsWith(`ks1.${LICENSEE}.qbo.`)).toBe(true);
    expect(unwrapState("qbo", wrapped, e)).toBe(inner);
    expect(unwrapState("google", wrapped, e)).toBeNull();
  });
});
