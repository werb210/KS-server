// KS_SERVER_v5_MAILING_ADDRESS - the licensee's mailing address (CASL) in marketing emails, invites and agreements.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mailingAddress, warmBrand } from "../licensee/brand.js";
import { checkField, clearLicenseeCache, LICENSEE_FIELDS, resetLastLoadedLicensee } from "../licensee/settings.js";
import { renderBrandedEmail } from "../services/emailTemplateRender.js";
import { buildAccountantInvite } from "../services/accountantInvite.js";

const db = (row: Record<string, unknown>) => ({ query: vi.fn(async (sql: string) => (/FROM licensee_settings/.test(sql) ? { rows: [row] } : { rows: [] })) });
const email = () => renderBrandedEmail({ headline: "Hi", heroUrl: "", heroLink: "", body: "Body", ctaLabel: "", ctaUrl: "", image2Url: "", image2Link: "" });
const invite = () => buildAccountantInvite({ accountantName: "Pat", accountantPhone: "+15875550100", applicantName: "Sam", businessName: "Acme", portalLink: "https://x.test" });

let prev: string | undefined;
beforeEach(() => { prev = process.env.KS_MAILING_ADDRESS; delete process.env.KS_MAILING_ADDRESS; clearLicenseeCache(); resetLastLoadedLicensee(); });
afterEach(() => { if (prev === undefined) delete process.env.KS_MAILING_ADDRESS; else process.env.KS_MAILING_ADDRESS = prev; clearLicenseeCache(); resetLastLoadedLicensee(); });

describe("licensee mailing address", () => {
  it("is a licensee setting, editable and length-checked", () => {
    expect(LICENSEE_FIELDS).toContain("mailing_address");
    expect(checkField("mailing_address", " 1 Main St, Calgary AB ")).toEqual({ ok: true, value: "1 Main St, Calgary AB" });
    expect(checkField("mailing_address", "x".repeat(201)).ok).toBe(false);
  });

  it("comes from the saved row, else KS_MAILING_ADDRESS, on one line", async () => {
    expect(mailingAddress()).toBe("");
    process.env.KS_MAILING_ADDRESS = "9 Env Rd\nEdmonton AB";
    expect(mailingAddress()).toBe("9 Env Rd, Edmonton AB");
    await warmBrand(db({ company_name: "Acme Capital", mailing_address: "1 Main St, Calgary AB T2P 1A1" }));
    expect(mailingAddress()).toBe("1 Main St, Calgary AB T2P 1A1");
  });

  it("appears in the marketing email footer and the accountant invite when set", async () => {
    expect(email()).not.toContain("Main St");
    await warmBrand(db({ company_name: "Acme Capital", mailing_address: "1 Main St, Calgary AB T2P 1A1" }));
    expect(email()).toContain("1 Main St, Calgary AB T2P 1A1");
    const i = invite() as unknown as { html?: string; text?: string };
    expect(JSON.stringify(i)).toContain("1 Main St, Calgary AB T2P 1A1");
  });
});
