// KS_SERVER_SSO_API_KEYS - id_token checks for staff SSO: signature against the provider's keys, issuer, audience,
// expiry, nonce, verified email, the Microsoft tenant and Google hosted-domain restrictions; PKCE in the authorize URL;
// and providers that are not set up are not offered.
import { generateKeyPairSync, createHash, type KeyObject } from "node:crypto";
import jwt from "jsonwebtoken";
import { describe, expect, it } from "vitest";
import {
  buildAuthorizeUrl, providerConfig, SsoError, verifyIdToken, type KeyResolver, type ProviderConfig,
} from "../oidc.js";

const TENANT = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
const OTHER_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";
const CLIENT = "client-123";
const NONCE = "nonce-abc";

const good = generateKeyPairSync("rsa", { modulusLength: 2048 });
const evil = generateKeyPairSync("rsa", { modulusLength: 2048 });
const resolver: KeyResolver = async (_p, kid) => (kid === "k1" ? (good.publicKey as KeyObject) : null);

function sign(claims: Record<string, unknown>, opts: { key?: KeyObject; kid?: string; expiresIn?: number } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign({ iat: now, exp: now + (opts.expiresIn ?? 600), aud: CLIENT, nonce: NONCE, ...claims }, opts.key ?? good.privateKey, {
    algorithm: "RS256", keyid: opts.kid ?? "k1",
  });
}

const googleClaims = { iss: "https://accounts.google.com", sub: "g-1", email: "Ann@Acme.com", email_verified: true, hd: "acme.com" };
const msClaims = { iss: `https://login.microsoftonline.com/${TENANT}/v2.0`, tid: TENANT, oid: "o-1", sub: "s-1", preferred_username: "ann@acme.com" };

async function reason(p: Promise<unknown>): Promise<string> {
  try { await p; return "accepted"; } catch (e) { return e instanceof SsoError ? e.reason : `other:${(e as Error).message}`; }
}

describe("verifyIdToken - Google", () => {
  it("accepts a correctly signed token for this client with a verified email", async () => {
    const id = await verifyIdToken("google", sign(googleClaims), { clientId: CLIENT, nonce: NONCE }, resolver);
    expect(id).toMatchObject({ provider: "google", email: "ann@acme.com", subject: "g-1", hostedDomain: "acme.com" });
  });
  it("refuses a bad signature (signed with a key the provider never published)", async () => {
    expect(await reason(verifyIdToken("google", sign(googleClaims, { key: evil.privateKey as KeyObject }), { clientId: CLIENT, nonce: NONCE }, resolver))).toBe("bad_signature");
  });
  it("refuses an unknown key id", async () => {
    expect(await reason(verifyIdToken("google", sign(googleClaims, { kid: "nope" }), { clientId: CLIENT, nonce: NONCE }, resolver))).toBe("bad_signature");
  });
  it("refuses a token minted for another app (wrong audience)", async () => {
    expect(await reason(verifyIdToken("google", sign({ ...googleClaims, aud: "someone-else" }), { clientId: CLIENT, nonce: NONCE }, resolver))).toBe("wrong_audience");
  });
  it("refuses an expired token", async () => {
    const now = Math.floor(Date.now() / 1000);
    const t = sign({ ...googleClaims, iat: now - 7200, exp: now - 3600 });
    expect(await reason(verifyIdToken("google", t, { clientId: CLIENT, nonce: NONCE }, resolver))).toBe("expired");
  });
  it("refuses an unverified email", async () => {
    expect(await reason(verifyIdToken("google", sign({ ...googleClaims, email_verified: false }), { clientId: CLIENT, nonce: NONCE }, resolver))).toBe("email_not_verified");
  });
  it("refuses another issuer and a replayed nonce", async () => {
    expect(await reason(verifyIdToken("google", sign({ ...googleClaims, iss: "https://evil.example" }), { clientId: CLIENT, nonce: NONCE }, resolver))).toBe("wrong_issuer");
    expect(await reason(verifyIdToken("google", sign(googleClaims), { clientId: CLIENT, nonce: "different" }, resolver))).toBe("bad_nonce");
  });
  it("enforces the hosted-domain restriction (hd claim and email domain)", async () => {
    expect(await reason(verifyIdToken("google", sign(googleClaims), { clientId: CLIENT, nonce: NONCE, hostedDomain: "other.com" }, resolver))).toBe("wrong_domain");
    expect(await reason(verifyIdToken("google", sign({ ...googleClaims, hd: undefined, email: "ann@gmail.com" }), { clientId: CLIENT, nonce: NONCE, hostedDomain: "acme.com" }, resolver))).toBe("wrong_domain");
    expect(await reason(verifyIdToken("google", sign(googleClaims), { clientId: CLIENT, nonce: NONCE, hostedDomain: "acme.com" }, resolver))).toBe("accepted");
  });
  it("refuses an HS256 token (algorithm confusion)", async () => {
    const t = jwt.sign({ ...googleClaims, aud: CLIENT, nonce: NONCE }, "shared", { algorithm: "HS256", keyid: "k1", expiresIn: 600 });
    expect(await reason(verifyIdToken("google", t, { clientId: CLIENT, nonce: NONCE }, resolver))).toBe("bad_token");
  });
});

describe("verifyIdToken - Microsoft", () => {
  it("accepts the token when the tenant is pinned and matches, using the sign-in name", async () => {
    const id = await verifyIdToken("microsoft", sign(msClaims), { clientId: CLIENT, nonce: NONCE, tenantRestriction: TENANT }, resolver);
    expect(id).toMatchObject({ provider: "microsoft", email: "ann@acme.com", tenantId: TENANT, subject: "o-1" });
  });
  it("refuses the wrong tenant (Admin restriction or the server's own tenant)", async () => {
    const other = sign({ ...msClaims, tid: OTHER_TENANT, iss: `https://login.microsoftonline.com/${OTHER_TENANT}/v2.0` });
    expect(await reason(verifyIdToken("microsoft", other, { clientId: CLIENT, nonce: NONCE, tenantRestriction: TENANT }, resolver))).toBe("wrong_tenant");
    expect(await reason(verifyIdToken("microsoft", other, { clientId: CLIENT, nonce: NONCE, serverTenant: TENANT }, resolver))).toBe("wrong_tenant");
  });
  it("refuses an issuer that does not match the token's tenant", async () => {
    const t = sign({ ...msClaims, iss: `https://login.microsoftonline.com/${OTHER_TENANT}/v2.0` });
    expect(await reason(verifyIdToken("microsoft", t, { clientId: CLIENT, nonce: NONCE }, resolver))).toBe("wrong_issuer");
  });
  it("with no tenant pinned, accepts the email only when Microsoft verified its domain (xms_edov)", async () => {
    expect(await reason(verifyIdToken("microsoft", sign({ ...msClaims, email: "ann@acme.com" }), { clientId: CLIENT, nonce: NONCE }, resolver))).toBe("email_not_verified");
    const id = await verifyIdToken("microsoft", sign({ ...msClaims, email: "Ann@Acme.com", xms_edov: true }), { clientId: CLIENT, nonce: NONCE }, resolver);
    expect(id.email).toBe("ann@acme.com");
  });
  it("refuses a bad signature, wrong audience and expiry like Google", async () => {
    expect(await reason(verifyIdToken("microsoft", sign(msClaims, { key: evil.privateKey as KeyObject }), { clientId: CLIENT, nonce: NONCE, tenantRestriction: TENANT }, resolver))).toBe("bad_signature");
    expect(await reason(verifyIdToken("microsoft", sign({ ...msClaims, aud: "x" }), { clientId: CLIENT, nonce: NONCE, tenantRestriction: TENANT }, resolver))).toBe("wrong_audience");
    expect(await reason(verifyIdToken("microsoft", sign(msClaims, { expiresIn: -3600 }), { clientId: CLIENT, nonce: NONCE, tenantRestriction: TENANT }, resolver))).toBe("expired");
  });
});

describe("provider configuration and the authorize URL", () => {
  it("is not offered when the app registration env vars are unset", () => {
    expect(providerConfig("microsoft", {})).toBeNull();
    expect(providerConfig("google", { GOOGLE_OAUTH_CLIENT_ID: "x" })).toBeNull();
    expect(providerConfig("google", { GOOGLE_OAUTH_CLIENT_ID: "x", GOOGLE_OAUTH_CLIENT_SECRET: "y" })).not.toBeNull();
  });
  it("pins Microsoft to MSAL_TENANT_ID when it is a tenant GUID", () => {
    const cfg = providerConfig("microsoft", { MSAL_CLIENT_ID: "c", MSAL_CLIENT_SECRET: "s", MSAL_TENANT_ID: TENANT })!;
    expect(cfg.serverTenant).toBe(TENANT);
    const open = providerConfig("microsoft", { MSAL_CLIENT_ID: "c", MSAL_CLIENT_SECRET: "s" })!;
    expect(open.serverTenant).toBeNull();
    expect(open.authorityTenant).toBe("organizations");
  });
  it("sends state, nonce and an S256 PKCE challenge; Google gets the hd hint", () => {
    const cfg: ProviderConfig = { provider: "google", clientId: CLIENT, clientSecret: "s", redirectUri: "https://srv.example/cb" };
    const url = new URL(buildAuthorizeUrl(cfg, { state: "st", nonce: "nn", verifier: "ver", hostedDomain: "acme.com" }));
    expect(url.searchParams.get("state")).toBe("st");
    expect(url.searchParams.get("nonce")).toBe("nn");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(createHash("sha256").update("ver").digest("base64url"));
    expect(url.searchParams.get("hd")).toBe("acme.com");
    expect(url.searchParams.get("scope")).toBe("openid email profile");
  });
  it("uses the Admin's tenant as the Microsoft authority when the server is not pinned", () => {
    const cfg = providerConfig("microsoft", { MSAL_CLIENT_ID: "c", MSAL_CLIENT_SECRET: "s" })!;
    const url = buildAuthorizeUrl(cfg, { state: "a", nonce: "b", verifier: "c", tenantRestriction: TENANT });
    expect(url.startsWith(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize?`)).toBe(true);
  });
});
