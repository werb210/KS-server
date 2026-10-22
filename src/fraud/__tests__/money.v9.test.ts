// KS_SERVER_v9_FRAUD - checks 2 (statement math), 3 (statement vs live bank), 4 (duplicates), 5 (revenue vs
// deposits) and 11 (stacking), plus the Flinks provider against a fake API.
import { describe, expect, it } from "vitest";
import { checkStatementArithmetic, type StatementRow } from "../checks/statementMath.js";
import { compareStatementToLive } from "../checks/liveBank.js";
import { flinksProvider, flinksTransactions, type LiveTx } from "../providers/bankData.js";
import { evaluateDuplicates } from "../checks/duplicates.js";
import { evaluateRevenue } from "../checks/revenue.js";
import { detectStacking, type BankLine } from "../checks/stacking.js";
import type { FetchLike } from "../providers/http.js";

const stmt = (rows: Array<[string, string, number | null, number | null]>): StatementRow[] => rows.map(([date, description, amount, balance]) => ({ date, description, amount, balance }));

describe("check 2: statement math", () => {
  const good = stmt([
    ["2026-01-01", "Opening balance", null, 1000],
    ["2026-01-02", "Deposit", 500, 1500],
    ["2026-01-03", "Cheque 101", -200, 1300],
    ["2026-01-03", "Fee", -5, null],
    ["2026-01-04", "Deposit", 100, 1395],
    ["2026-01-31", "Closing balance", null, 1395],
  ]);

  it("a statement whose balances and totals add up is green", () => {
    const r = checkStatementArithmetic(good);
    expect(r.status).toBe("green");
    expect(r.details).toMatchObject({ checked: 3, breaks: 0, opening: 1000, closing: 1395 });
  });

  it("an edited deposit breaks the running balance and the totals: red", () => {
    const edited = good.map((r) => (r.description === "Deposit" && r.amount === 500 ? { ...r, amount: 5000 } : r));
    const r = checkStatementArithmetic(edited);
    expect(r.status).toBe("red");
    expect(r.reasons.map((x) => x.code)).toEqual(expect.arrayContaining(["totals_mismatch", "balance_breaks"]));
    expect(r.reasons.find((x) => x.code === "totals_mismatch")!.text).toMatch(/off by/);
  });

  it("one break alone is amber (could be a misread scan)", () => {
    const rows = stmt([["2026-01-01", "Opening balance", null, 100], ["2026-01-02", "a", 10, 110], ["2026-01-03", "b", 10, 120], ["2026-01-04", "c", 10, 131], ["2026-01-05", "d", 10, 141], ["2026-01-06", "e", 10, 151], ["2026-01-07", "f", 10, 161], ["2026-01-08", "g", 10, 171], ["2026-01-09", "h", 10, 181], ["2026-01-10", "i", 10, 191], ["2026-01-11", "j", 10, 201], ["2026-01-12", "k", 10, 211]]);
    const r = checkStatementArithmetic(rows);
    expect(r.status).toBe("amber");
    expect(r.details).toMatchObject({ breaks: 1 });
  });

  it("a withdrawal read as a deposit is a reading problem, not an edit", () => {
    const rows = stmt([["2026-01-01", "Opening balance", null, 100], ["2026-01-02", "a", 50, 150], ["2026-01-03", "b", 20, 130], ["2026-01-04", "c", 10, 140]]);
    const r = checkStatementArithmetic(rows);
    expect(r.status).toBe("green");
    expect(r.reasons[0]!.code).toBe("sign_ambiguous");
  });

  it("without running balances or opening/closing lines it says it could not check", () => {
    expect(checkStatementArithmetic(stmt([["2026-01-02", "a", 50, null], ["2026-01-03", "b", 20, null]])).status).toBe("not_applicable");
    expect(checkStatementArithmetic([]).status).toBe("not_applicable");
  });
});

describe("check 3: statement vs live bank data", () => {
  const live: LiveTx[] = [
    { date: "2026-01-02", description: "Deposit ACME PAYROLL", amount: 500, balance: 1500, account: "chq" },
    { date: "2026-01-03", description: "Cheque 101", amount: -200, balance: 1300, account: "chq" },
    { date: "2026-01-04", description: "Deposit", amount: 100, balance: 1400, account: "chq" },
    { date: "2026-01-02", description: "Savings interest", amount: 1.2, balance: 9001.2, account: "sav" },
  ];
  const s = (rows: Array<[string, string, number, number | null]>) => rows.map(([date, description, amount, balance]) => ({ date, description, amount, balance }));

  it("matching transactions on the best-matching account are green", () => {
    const r = compareStatementToLive(s([["2026-01-02", "Deposit ACME", 500, 1500], ["2026-01-03", "Cheque 101", -200, 1300], ["2026-01-04", "Deposit", 100, 1400]]), live);
    expect(r.status).toBe("green");
    expect(r.details).toMatchObject({ matched: 3, added: 0, removed: 0 });
  });

  it("finds an altered amount, an added deposit and a removed withdrawal", () => {
    const r = compareStatementToLive(s([["2026-01-02", "Deposit ACME PAYROLL", 5000, null], ["2026-01-04", "Deposit", 100, null], ["2026-01-04", "Customer payment", 2500, null]]), live);
    expect(r.status).toBe("red");
    const codes = r.reasons.map((x) => x.code);
    expect(codes).toEqual(expect.arrayContaining(["altered", "added", "removed"]));
  });

  it("no live data for the period is not a pass", () => {
    expect(compareStatementToLive(s([["2025-05-01", "x", 10, null]]), live).status).toBe("not_applicable");
  });

  it("parses Flinks accounts and talks to Flinks only when configured", async () => {
    expect(flinksTransactions({ Accounts: [{ Id: "a1", Transactions: [{ Date: "2026/01/02", Description: "X", Credit: 10, Debit: null, Balance: 5 }, { Date: "2026/01/03", Description: "Y", Debit: 4 }] }] }))
      .toEqual([{ date: "2026-01-02", description: "X", amount: 10, balance: 5, account: "a1" }, { date: "2026-01-03", description: "Y", amount: -4, balance: null, account: "a1" }]);
    expect(flinksProvider({ NODE_ENV: "test" } as any).configured()).toBe(false);
    const calls: string[] = [];
    const fake: FetchLike = async (url) => {
      calls.push(url);
      const body = url.endsWith("/Authorize") ? { RequestId: "req-1" } : { Accounts: [{ Id: "a", Transactions: [{ Date: "2026-01-02", Description: "D", Credit: 1 }] }] };
      return { ok: true, status: 200, json: async () => body, text: async () => "" };
    };
    const p = flinksProvider({ FLINKS_BASE_URL: "https://x-api.private.fin.ag/", FLINKS_CUSTOMER_ID: "cust" } as any, fake);
    expect(p.configured()).toBe(true);
    const r = await p.fetchTransactions("login-123");
    expect(r).toEqual({ ok: true, transactions: [{ date: "2026-01-02", description: "D", amount: 1, balance: null, account: "a" }] });
    expect(calls).toEqual(["https://x-api.private.fin.ag/v3/cust/BankingServices/Authorize", "https://x-api.private.fin.ag/v3/cust/BankingServices/GetAccountsDetail"]);
  });
});

describe("check 4: duplicates", () => {
  it("a void cheque on another business is red; the same business re-applying is only mentioned", () => {
    const r = evaluateDuplicates([
      { match: "near", idKind: "void_cheque", otherApplicationId: "b", sameBusiness: false, otherIsFraud: false, distance: 2 },
      { match: "exact", idKind: "other", otherApplicationId: "c", sameBusiness: true, otherIsFraud: false },
    ], 4);
    expect(r.status).toBe("red");
    expect(r.reasons.map((x) => x.code)).toEqual(["duplicate_near_void_cheque", "duplicate_same_business"]);
    expect(evaluateDuplicates([{ match: "exact", idKind: "other", otherApplicationId: "d", sameBusiness: false, otherIsFraud: false }], 1).status).toBe("amber");
    expect(evaluateDuplicates([], 3).status).toBe("green");
  });
});

describe("check 5: revenue vs deposits", () => {
  const dep = { monthlyAverage: 50_000, months: 6 }; // 600k a year
  it("within 40% is consistent, above is amber, more than double is red, far below is amber", () => {
    expect(evaluateRevenue([{ source: "tax_return", label: "", min: 750_000, max: 750_000 }], dep).status).toBe("green");
    expect(evaluateRevenue([{ source: "financials", label: "", min: 1_000_000, max: 1_000_000 }], dep).status).toBe("amber");
    const red = evaluateRevenue([{ source: "application", label: "", min: 1_500_000, max: 2_000_000 }], dep);
    expect(red.status).toBe("red");
    expect(red.reasons[0]!.text).toMatch(/more than double/);
    expect(evaluateRevenue([{ source: "tax_return", label: "", min: 150_000, max: 150_000 }], dep).reasons[0]!.code).toBe("deposits_over_tax_return");
  });
  it("needs two months of deposits and at least one revenue figure", () => {
    expect(evaluateRevenue([{ source: "tax_return", label: "", min: 1, max: 1 }], { monthlyAverage: 10, months: 1 }).status).toBe("not_applicable");
    expect(evaluateRevenue([], dep).status).toBe("not_applicable");
  });
});

describe("check 11: stacking", () => {
  const daily = (n: number, amount: number, desc: string): BankLine[] => Array.from({ length: n }, (_, i) => ({ date: `2026-02-${String(i + 2).padStart(2, "0")}`, description: desc, amount }));
  it("an MCA advance and daily repayments not disclosed is red", () => {
    const lines = [{ date: "2026-02-01", description: "MERCHANT GROWTH FUNDING", amount: 40_000 }, ...daily(15, -412.5, "ACH DEBIT MERCHANT GROWTH")];
    const r = detectStacking(lines, "");
    expect(r.status).toBe("red");
    expect(r.reasons.map((x) => x.code)).toEqual(expect.arrayContaining(["stacking_advance", "stacking_repayments"]));
  });
  it("daily equal debits from an unnamed payee are found; disclosed debt makes it amber", () => {
    const r = detectStacking(daily(12, -250, "PREAUTH DEBIT 88231"), "Existing advance with a funder, $250 a day");
    expect(r.status).toBe("amber");
    expect(r.reasons[0]!.text).toMatch(/unnamed payee/);
  });
  it("weekly payroll is not stacking", () => {
    const weekly: BankLine[] = Array.from({ length: 10 }, (_, i) => ({ date: new Date(Date.UTC(2026, 0, 2 + i * 7)).toISOString().slice(0, 10), description: "PAYROLL", amount: -3000 }));
    expect(detectStacking(weekly, "").status).toBe("green");
    expect(detectStacking([], "").status).toBe("not_applicable");
  });
});
