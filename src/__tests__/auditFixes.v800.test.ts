// BF_SERVER_AUDIT_v800
import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { readFileSync } from "node:fs";

vi.mock("../middleware/auth.js", () => ({ requireAuth: (_req: any, _res: any, next: any) => next() }));
vi.mock("../db.js", () => ({
  pool: {
    query: vi.fn(async (sql: string) => {
      if (/GROUP BY pipeline_state/.test(sql)) return { rows: [{ stage: "review", n: 2, total: "500000" }] };
      if (/GROUP BY product_category/.test(sql)) return { rows: [{ product_family: "term_loan", n: 2 }] };
      if (/FROM applications a\s+LEFT JOIN contacts/.test(sql)) return { rows: [{ id: "a1", company_name: "Acme", stage: "review" }] };
      if (/SELECT \* FROM applications WHERE id::text/.test(sql)) return { rows: [{ id: "a1", silo: "SLF" }] };
      if (/FROM documents/.test(sql)) return { rows: [{ id: "d1", filename: "x.pdf" }] };
      return { rows: [] };
    }),
  },
}));



describe("1919 Owner's Position", () => {
  it("says Owner when no title is entered", () => {
    expect(readFileSync("src/signnow/sba/sbaDemographics.ts", "utf8")).toContain('values[F.demoOwnerPosition] = owner.title || "Owner"');
  });
});
