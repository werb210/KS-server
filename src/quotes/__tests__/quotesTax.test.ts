// KS_BROKER_TOOLS_3_SALES_TAX - the quote maths with the sales-tax helper plugged into its FeeTax hook.
import { describe, expect, it } from "vitest";
import { computeOption } from "../calc.js";
import { defaultRate, feeTaxFor } from "../../brokerTools/salesTax.js";

describe("quote maths with sales tax", () => {
  it("plugs into the quote maths: only fees ticked taxable are taxed, and the tax is part of the fees", () => {
    const fees = [{ label: "Documentation", amount: 300, deducted: false, taxable: true }, { label: "Admin", amount: 200, deducted: true }];
    const m = computeOption({ amount: 10_000, term_months: 12, rate_kind: "interest_rate", rate: 10, payment_frequency: "monthly", fees }, feeTaxFor(defaultRate("ON")));
    expect(m.tax_lines).toEqual([{ label: "HST 13%", amount: 39 }]);
    expect(m.total_tax).toBe(39);
    expect(m.total_fees).toBe(539);
    const none = computeOption({ amount: 10_000, term_months: 12, rate_kind: "interest_rate", rate: 10, payment_frequency: "monthly", fees }, feeTaxFor(null));
    expect(none.total_tax).toBe(0);
    expect(none.total_fees).toBe(500);
  });
});
