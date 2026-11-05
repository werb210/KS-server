// KS_CLIENT_LANGUAGES_v1 - the brokerage's client languages, each client's choice, and wording in that language.
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";
import { asLang, marketingSmsOptinTextIn, normaliseLanguages, smsUpdatesConsentTextIn, verifyLocale } from "../clientLanguage/language.js";
import { checkField } from "../licensee/settings.js";

const h = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../db.js", async () => ({ ...(await vi.importActual<any>("../db.js")), pool: { query: h.query }, dbQuery: h.query, runQuery: h.query }));
vi.mock("../licensee/settings.js", async () => ({
  ...(await vi.importActual<any>("../licensee/settings.js")),
  getLicenseeSettings: async () => ({ client_languages: "en,fr" }),
}));

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-languages";

describe("languages", () => {
  it("normalises the brokerage setting with English first", () => {
    expect(normaliseLanguages("es, fr, de")).toBe("en,fr,es");
    expect(normaliseLanguages("")).toBe("en");
    expect(checkField("client_languages", "FR")).toEqual({ ok: true, value: "en,fr" });
  });
  it("maps languages to Twilio Verify locales", () => {
    expect(verifyLocale("fr")).toBe("fr");
    expect(verifyLocale("es")).toBe("es");
    expect(verifyLocale("en")).toBeUndefined();
    expect(asLang("fr-CA")).toBe("fr");
    expect(asLang("de")).toBeNull();
  });
  it("stores consent wording in the language the client saw", () => {
    expect(marketingSmsOptinTextIn("fr", "Northwind")).toMatch(/^Facultatif : m'envoyer par texto .* de Northwind\./);
    expect(marketingSmsOptinTextIn("en", "Northwind")).toMatch(/^Optional: Text me news, tips and offers from Northwind\./);
    expect(smsUpdatesConsentTextIn("es", "EN")).toMatch(/^Enviarme mensajes de texto sobre mi solicitud/);
    expect(smsUpdatesConsentTextIn(null, "EN")).toBe("EN");
  });
});

describe("PUT /api/client/language", () => {
  beforeEach(() => { h.query.mockReset(); h.query.mockImplementation(answerBySql([[/UPDATE contacts SET preferred_language/, { rows: [], rowCount: 1 }]])); });
  async function app() {
    const a = express(); a.use(express.json());
    a.use("/api/client", (await import("../clientLanguage/routes.js")).default);
    return a;
  }
  const token = () => jwt.sign({ phone: "+17805550100", role: "client" }, process.env.JWT_SECRET!, { algorithm: "HS256" });

  it("saves an offered language on the client's contacts", async () => {
    const res = await request(await app()).put("/api/client/language").set("Authorization", `Bearer ${token()}`).send({ language: "fr" });
    expect(res.status).toBe(200);
    expect(callsMatching(h.query, /UPDATE contacts SET preferred_language/)[0]![1]).toEqual(["7805550100", "fr"]);
  });
  it("refuses a language the brokerage does not offer, and a missing sign-in", async () => {
    expect((await request(await app()).put("/api/client/language").set("Authorization", `Bearer ${token()}`).send({ language: "es" })).status).toBe(400);
    expect((await request(await app()).put("/api/client/language").send({ language: "fr" })).status).toBe(401);
  });
});
