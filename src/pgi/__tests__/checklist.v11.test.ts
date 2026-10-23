// KS_SERVER_v11_PGI - PGI checklist logic: document mapping, startup rule, what gets forwarded, field checks, payload.
import { describe, expect, it } from "vitest";
import {
  buildChecklist, cleanInputPatch, documentsToForward, missingFields, partnerReferralBody, pgiInputFromApplication, pgiSlotFor,
  requiredSlots, type KsDocument,
} from "../checklist.js";
import { allowedPartnerUrl, openSecret, sealSecret } from "../partner.js";

const NOW = new Date("2026-10-22T12:00:00Z");
const doc = (id: string, category: string, status: string, created: string, document_type?: string): KsDocument =>
  ({ id, category, document_type: document_type ?? category, status, created_at: created });

describe("document mapping", () => {
  it("maps this system's categories and labels onto the insurer's slots", () => {
    expect(pgiSlotFor("signed_term_sheet")).toBe("loan_agreement");
    expect(pgiSlotFor("PnL - Interim financials")).toBe("profit_loss");
    expect(pgiSlotFor("PnL – Interim financials")).toBe("profit_loss");
    expect(pgiSlotFor("Balance Sheet - Interim financials")).toBe("balance_sheet");
    expect(pgiSlotFor("A/R")).toBe("ar_aging");
    expect(pgiSlotFor("accounts_payable_aging")).toBe("ap_aging");
    expect(pgiSlotFor("Business plan / projections")).toBe("financial_forecast");
    expect(pgiSlotFor("2 pieces of Government Issued ID")).toBe("kyc_id");
    expect(pgiSlotFor("bank_statements_6_months")).toBeNull();
    expect(pgiSlotFor("financial_statements")).toBeNull();
    expect(pgiSlotFor("")).toBeNull();
  });

  it("five documents always; founder CV and forecast under three years", () => {
    expect(requiredSlots("2015-01-01", NOW)).toEqual(["loan_agreement", "profit_loss", "balance_sheet", "ar_aging", "ap_aging"]);
    expect(requiredSlots("2024-06-01", NOW)).toEqual(["loan_agreement", "profit_loss", "balance_sheet", "ar_aging", "ap_aging", "founder_cv", "financial_forecast"]);
    expect(requiredSlots(null, NOW)).toHaveLength(5);
  });
});

describe("documentsToForward", () => {
  it("accepted documents only, the newest per slot, plus the system's signed term sheet", () => {
    const docs = [
      doc("d1", "PnL - Interim financials", "accepted", "2026-10-01"),
      doc("d2", "PnL - Interim financials", "accepted", "2026-10-05"),
      doc("d3", "A/R", "uploaded", "2026-10-05"),
      doc("d4", "signed_term_sheet", "uploaded", "2026-10-06"),
      doc("d5", "bank_statements_6_months", "accepted", "2026-10-06"),
      doc("d6", "Balance Sheet - Interim financials", "rejected", "2026-10-06"),
    ];
    expect(documentsToForward(docs).map((f) => [f.doc.id, f.slot])).toEqual([["d4", "loan_agreement"], ["d2", "profit_loss"]]);
  });

  it("a rejected signed term sheet is not sent; up to two government IDs are", () => {
    const docs = [
      doc("t1", "signed_term_sheet", "rejected", "2026-10-06"),
      doc("i1", "government_id", "accepted", "2026-10-01"),
      doc("i2", "government_id", "accepted", "2026-10-02"),
      doc("i3", "government_id", "accepted", "2026-10-03"),
    ];
    expect(documentsToForward(docs).map((f) => f.doc.id)).toEqual(["i3", "i2"]);
  });
});

describe("buildChecklist", () => {
  it("shows what is missing, waiting for review here, ready, sent, and what the insurer has", () => {
    const docs = [
      doc("a", "signed_term_sheet", "uploaded", "2026-10-06"),
      doc("b", "PnL - Interim financials", "accepted", "2026-10-05"),
      doc("c", "A/R", "uploaded", "2026-10-05"),
      doc("d", "Balance Sheet - Interim financials", "accepted", "2026-10-05"),
    ];
    const c = buildChecklist({
      formationDate: "2015-01-01", documents: docs, forwardedSlots: new Set(["loan_agreement"]),
      partnerDocs: [{ slot: "balance_sheet", status: "accepted" }, { slot: "ap_aging", status: "rejected", rejection_reason: "Too old" }], now: NOW,
    });
    const by = Object.fromEntries(c.rows.map((r) => [r.slot, r]));
    expect(by.loan_agreement.state).toBe("sent");
    expect(by.profit_loss.state).toBe("ready");
    expect(by.balance_sheet.state).toBe("accepted");
    expect(by.ar_aging.state).toBe("awaiting_review");
    expect(by.ap_aging).toMatchObject({ state: "rejected", detail: "Too old" });
    expect(c.missing.map((r) => r.slot)).toEqual(["ar_aging", "ap_aging"]);
    expect(c.startup).toBe(false);
  });
});

describe("fields the insurer needs", () => {
  const full = {
    business_legal_name: "Widget Co", operating_address: "2 Main St, Calgary AB", country: "CA", naics_code: "236220",
    formation_date: "2015-01-01", guarantor_name: "Jane Doe", guarantor_phone: "+14035550100", guarantor_dob: "1980-02-03",
    residential_address: "1 Main St", loan_amount: 500000, pgi_limit: 400000, loan_type: "Other Secured Loan",
  };

  it("nothing missing on a complete file", () => {
    expect(missingFields(full)).toEqual([]);
  });

  it("names each missing or invalid field", () => {
    const keys = missingFields({ ...full, naics_code: "2362", loan_type: "Unsecured", pgi_limit: 450000, guarantor_dob: null }).map((f) => f.key);
    expect(keys).toEqual(["guarantor_dob", "naics_code", "loan_type", "pgi_limit"]);
    expect(missingFields({ ...full, country: "US", loan_type: null })).toEqual([]);
    expect(missingFields({ ...full, loan_amount: 25000, pgi_limit: null }).map((f) => f.key)).toEqual(["loan_amount"]);
  });

  it("reads the client's application and their PGI answers", () => {
    const input = pgiInputFromApplication({
      legacyApp: {
        kyc: { fundingAmount: "500000", purposeOfFunds: "Expansion" },
        pgi_details: { loan_type: "Commercial Mortgage", naics_code: "236220", formation_date: "2016-05-01", residential_address: "1 Main St" },
      },
      businessSource: { legalName: "Widget Co", city: "Calgary", province: "ab", country: "Canada" },
      applicantSource: { firstName: "Jane", lastName: "Doe", phone: "(403) 555-0100", dob: "1980-02-03", email: "jane@widget.example" },
    });
    expect(input).toMatchObject({
      business_legal_name: "Widget Co", province: "AB", country: "CA", naics_code: "236220", formation_date: "2016-05-01",
      guarantor_name: "Jane Doe", guarantor_phone: "+14035550100", guarantor_dob: "1980-02-03", residential_address: "1 Main St",
      loan_amount: 500000, loan_type: "Commercial Mortgage", loan_purpose: "Expansion",
    });
    const body = partnerReferralBody("app-1", input, { user_id: "u1", name: "Sam", email: "sam@x.example" });
    expect(body).toMatchObject({ ks_application_id: "app-1", broker: { name: "Sam" }, business: { legal_name: "Widget Co", naics: "236220" },
      guarantor: { phone: "+14035550100" }, loan: { amount: 500000, loan_type: "Commercial Mortgage" } });
  });

  it("staff edits are cleaned", () => {
    expect(cleanInputPatch({ naics_code: " 236220 ", loan_type: "bogus", pgi_limit: "300,000", guarantor_phone: "403 555 0100", province: "ab", junk: 1 }))
      .toEqual({ naics_code: "236220", loan_type: null, pgi_limit: 300000, guarantor_phone: "+14035550100", province: "AB" });
  });
});

describe("partner link helpers", () => {
  it("secrets are sealed and opened again", () => {
    const sealed = sealSecret("bk_ks_secret_value_123456");
    expect(sealed.startsWith("v1:")).toBe(true);
    expect(sealed).not.toContain("bk_ks_secret");
    expect(openSecret(sealed)).toBe("bk_ks_secret_value_123456");
  });

  it("partner URL must be https on an allowed host", () => {
    expect(allowedPartnerUrl("https://bi-server-x.canadacentral-01.azurewebsites.net/")).toBe("https://bi-server-x.canadacentral-01.azurewebsites.net");
    expect(allowedPartnerUrl("http://bi.azurewebsites.net")).toBeNull();
    expect(allowedPartnerUrl("https://evil.example")).toBeNull();
    expect(allowedPartnerUrl("https://bi.partner.example", { KS_PGI_ALLOWED_HOSTS: "bi.partner.example" } as NodeJS.ProcessEnv)).toBe("https://bi.partner.example");
  });
});
