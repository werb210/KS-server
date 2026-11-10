// KS_SERVER_MARKETING_CONTACTS_v1 - only contacts marked "Marketing contact" get marketing; imports come in unmarked.
import { describe, expect, it } from "vitest";
import { EMAIL_FALLBACK_ELIGIBLE_SQL, MARKETING_CONTACT_SQL, SMS_ELIGIBLE_SQL, CAMPAIGN_ELIGIBLE_SQL } from "../smsConsent.js";
import { EMAIL_BLAST_ELIGIBLE_SQL } from "../marketingSendRunner.js";
import { autoMatch, FIELDS } from "../../import/fields.js";
import { normalise } from "../../import/normalise.js";

describe("marketing contact gate", () => {
  it("every marketing audience predicate requires a marketing contact", () => {
    expect(MARKETING_CONTACT_SQL).toBe("COALESCE(c.marketing_contact, true) = true");
    for (const sql of [SMS_ELIGIBLE_SQL, EMAIL_FALLBACK_ELIGIBLE_SQL, CAMPAIGN_ELIGIBLE_SQL]) expect(sql).toContain(MARKETING_CONTACT_SQL);
    expect(EMAIL_BLAST_ELIGIBLE_SQL).toContain("COALESCE(c.marketing_contact, true) = true");
    expect(EMAIL_BLAST_ELIGIBLE_SQL).toContain("marketing_opt_out");
  });
});

describe("import: Marketing contact column", () => {
  it("is a contact field the wizard matches by header", () => {
    expect(FIELDS.contacts.some((f) => f.key === "marketing_contact")).toBe(true);
    expect(autoMatch("csv" as any, "contacts", ["Email", "Marketing contact"]).marketing_contact).toBe("Marketing contact");
  });
  it("reads yes / no and leaves a blank unset", () => {
    expect(normalise("contacts", { email: "a@example.com", marketing_contact: "Yes" }).values.marketing_contact).toBe(true);
    expect(normalise("contacts", { email: "a@example.com", marketing_contact: "no" }).values.marketing_contact).toBe(false);
    expect("marketing_contact" in normalise("contacts", { email: "a@example.com", marketing_contact: "" }).values).toBe(false);
  });
});
