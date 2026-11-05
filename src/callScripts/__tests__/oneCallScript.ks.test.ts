// KS_ONE_CALL_SCRIPT - the intake call is an ordinary, editable call script; the migration adds the same script;
// the dialler script is a per-script choice an Admin makes. No Boreal wording: "{company}" becomes the brokerage's name.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { INTAKE_CALL_NAME, intakeCallScript } from "../intakeCall.js";
import { rowToScript, validateScript } from "../scripts.js";

const migration = readFileSync(path.resolve(process.cwd(), "migrations/2026_11_19_ks_one_call_script.sql"), "utf8");
const db = { query: vi.fn(async () => ({ rows: [] })) };

describe("the intake call as a call script", () => {
  it("keeps every step the dialler used to show, with the brokerage's name and no Boreal text", () => {
    const s = intakeCallScript();
    expect(s.sections.map((x) => x.title)[0]).toBe("Recording consent (read first)");
    expect(s.sections).toHaveLength(15);
    expect(s.sections[1]!.body).toContain("Thank you for calling {company}.");
    expect(JSON.stringify(s)).not.toMatch(/Boreal/);
  });

  it("passes the same checks as a script an Admin builds", async () => {
    const r = await validateScript(db as any, intakeCallScript());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.dialer_default).toBe(true);
  });

  it("the migration adds the same script once, and only takes the dialler spot when it is free", () => {
    const json = /'(\[.*\])'::jsonb/s.exec(migration)?.[1];
    expect(JSON.parse(json!.replace(/''/g, "'"))).toEqual(intakeCallScript().sections);
    expect(migration).toContain(`'${INTAKE_CALL_NAME}'`);
    expect(migration).toMatch(/NOT EXISTS \(SELECT 1 FROM call_scripts WHERE dialer_default AND archived_at IS NULL\)/);
    expect(migration).toMatch(/WHERE NOT EXISTS \(SELECT 1 FROM call_scripts WHERE lower\(name\)/);
  });

  it("the dialler choice is off unless asked for", async () => {
    const base = { name: "Renewal", sections: [{ title: "Check-in", questions: [] }] };
    const off = await validateScript(db as any, base);
    expect(off.ok && off.value.dialer_default).toBe(false);
    expect(rowToScript({ id: "x", name: "n", use_for: "any", sections: [], dialer_default: true }).dialer_default).toBe(true);
  });
});
