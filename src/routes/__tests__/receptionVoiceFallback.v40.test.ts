// BF_SERVER_RECEPTION_VOICE_FALLBACK_v40
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import twilio from "twilio";

const h = vi.hoisted(() => ({ speech: vi.fn(), query: vi.fn(async () => ({ rows: [] })) }));
vi.mock("twilio", async () => await vi.importActual<typeof import("twilio")>("twilio"));
vi.mock("../../db", async () => {
  const actual = await vi.importActual<typeof import("../../db.js")>("../../db");
  return { ...actual, pool: { query: h.query }, runQuery: h.query, dbQuery: h.query, query: h.query };
});
vi.mock("../../lib/sharedClients.js", async (orig) => ({
  ...(await orig<typeof import("../../lib/sharedClients.js")>()),
  sharedOpenAI: () => ({ audio: { speech: { create: h.speech } } }),
}));

import receptionRouter, { shouldPlayAudio, warmReceptionVoice, __receptionVoiceCacheForTests } from "../reception.js";

const cache = __receptionVoiceCacheForTests();
const previous = process.env.RECEPTION_NOVA_VOICE;
const previousKey = process.env.OPENAI_API_KEY;
const BASE = "/api/webhooks/twilio/reception";

// The router from the same module instance as the cache seam above.
async function app() {
  const a = express();
  a.use(BASE, receptionRouter);
  return a;
}
async function post(path: string, params: Record<string, string> = {}) {
  const full = BASE + path;
  const res = await request(await app()).post(full).type("form").set("X-Forwarded-Host", "example.com").set("X-Forwarded-Proto", "https")
    .set("X-Twilio-Signature", twilio.getExpectedTwilioSignature(String(process.env.TWILIO_AUTH_TOKEN), "https://example.com" + full, params))
    .send(params);
  expect(res.status).toBe(200);
  return res.text;
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  cache.clear();
  h.speech.mockReset();
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  process.env.RECEPTION_NOVA_VOICE = previous;
  process.env.OPENAI_API_KEY = previousKey;
  warn.mockRestore();
});

describe("a cold cache can no longer point a live call at a 503", () => {
  it("does not play audio that has not been rendered", () => {
    process.env.RECEPTION_NOVA_VOICE = "true";
    expect(shouldPlayAudio("greeting")).toBe(false);
  });

  it("plays it once it really is cached", () => {
    process.env.RECEPTION_NOVA_VOICE = "true";
    cache.set("greeting", Buffer.from("fake-mp3"));
    expect(shouldPlayAudio("greeting")).toBe(true);
  });

  it("never plays when the nova voice is switched off", () => {
    process.env.RECEPTION_NOVA_VOICE = "false";
    cache.set("greeting", Buffer.from("fake-mp3"));
    expect(shouldPlayAudio("greeting")).toBe(false);
  });

  it("decides per line, so one failed render cannot mute the rest", () => {
    process.env.RECEPTION_NOVA_VOICE = "true";
    cache.set("greeting", Buffer.from("fake-mp3"));
    expect(shouldPlayAudio("greeting")).toBe(true);
    expect(shouldPlayAudio("intent_prompt")).toBe(false);
  });
});

describe("emit routes through that decision", () => {
  it("a cached line is played; everything else is spoken by Polly", async () => {
    process.env.RECEPTION_NOVA_VOICE = "true";
    cache.set("meeting_prompt", Buffer.from("fake-mp3"));
    const prompt = await post("/meeting");
    expect(prompt).toContain(`<Play>${BASE}/voice?key=meeting_prompt</Play>`);
    expect(prompt).not.toContain("<Say");
    // meeting_retry is not rendered: Polly, and no Play anywhere.
    const retry = await post("/meeting?try=1");
    expect(retry).toContain('<Say voice="Polly.Joanna">Sorry, that code isn');
    expect(retry).not.toContain("<Play>");
  });

  it("with the nova voice off nothing is played", async () => {
    process.env.RECEPTION_NOVA_VOICE = "false";
    cache.set("meeting_prompt", Buffer.from("fake-mp3"));
    const greeting = await post("/meeting");
    expect(greeting).not.toContain("<Play>");
    expect(greeting).toContain('<Say voice="Polly.Joanna">');
  });
});

describe("a render failure is legible instead of silent", () => {
  it("says why: no key", async () => {
    delete process.env.OPENAI_API_KEY;
    const res = await request(await app()).get(`${BASE}/voice?key=meeting_prompt`);
    expect(res.status).toBe(503);
    expect(warn).toHaveBeenCalledWith("reception_voice_render_failed", { reason: "no_openai_api_key" });
  });

  it("says why: the provider's own error, rather than swallowing every cause alike", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    h.speech.mockRejectedValue(new Error("model tts-1 has been retired"));
    const res = await request(await app()).get(`${BASE}/voice?key=meeting_prompt`);
    expect(res.status).toBe(503);
    expect(warn).toHaveBeenCalledWith("reception_voice_render_failed", { reason: "model tts-1 has been retired" });
  });

  it("reports how much of the greeting is degraded at boot", async () => {
    process.env.RECEPTION_NOVA_VOICE = "true";
    process.env.OPENAI_API_KEY = "sk-test";
    let n = 0;
    h.speech.mockImplementation(async () => { n += 1; if (n > 2) throw new Error("rate limited"); return { arrayBuffer: async () => new ArrayBuffer(4) }; });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await warmReceptionVoice();
      const call = log.mock.calls.find((c: unknown[]) => c[0] === "reception_voice_warm");
      expect(call).toBeDefined();
      const info = call![1] as { rendered: number; total: number; degradedToPolly: number };
      expect(info.rendered).toBe(2);
      expect(info.degradedToPolly).toBe(info.total - 2);
      expect(info.total).toBeGreaterThan(2);
    } finally {
      log.mockRestore();
    }
  });
});

describe("the greeting comes from the brokerage's phone menu (KS_SETTINGS_PACK_v1_PHONE_MENU)", () => {
  it("keeps the keypad and speech fallback and the handoff to the choice step", async () => {
    process.env.RECEPTION_NOVA_VOICE = "false";
    h.query.mockImplementation(async (sql: string) => (/FROM users\s+WHERE COALESCE\(active/.test(String(sql))
      ? { rows: [{ id: "11111111-1111-4111-8111-111111111111", first_name: "Jane", last_name: "Smith", role: "Admin" }] }
      : { rows: [] }) as any);
    const xml = await post("/greeting");
    expect(xml).toContain('input="speech dtmf"');
    expect(xml).toContain("Thank you for calling Keystone Demo Brokerage. For Jane Smith, press 1.");
    expect(xml).toContain(`action="${BASE}/choice"`);
    expect(xml).toContain(`<Redirect method="POST">${BASE}/choice</Redirect>`);
    h.query.mockImplementation(async () => ({ rows: [] }));
  });
});
