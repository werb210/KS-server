// KS_SERVER_SIGNNOW_SHARED_v1
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); vi.unstubAllEnvs(); });

describe("SignNow on shared hosting", () => {
  it("SIGNNOW_ keys are not per brokerage any more, but the callback address is", async () => {
    const { isPerBrokerageKey } = await import("../../tenancy/envOverlay.js");
    expect(isPerBrokerageKey("SIGNNOW_API_KEY")).toBe(false);
    expect(isPerBrokerageKey("SIGNNOW_WEBHOOK_SECRET")).toBe(false);
    expect(isPerBrokerageKey("SIGNNOW_WEBHOOK_URL")).toBe(true);
  });

  it("subscribes a new document's signed and complete events to the brokerage's own address", async () => {
    vi.doMock("../../tenancy/mode.js", async (orig) => ({ ...(await orig<any>()), isMultiBrokerage: () => true }));
    vi.doMock("../../tenancy/context.js", async (orig) => ({ ...(await orig<any>()), currentTenant: () => ({ code: "kt1" }) }));
    vi.doMock("../../licensee/urls.js", async (orig) => ({ ...(await orig<any>()), serverUrl: () => "https://kt1.api.keystonecrm.online/" }));
    vi.stubEnv("SIGNNOW_API_KEY", "k"); vi.stubEnv("SIGNNOW_WEBHOOK_SECRET", "s"); vi.stubEnv("SIGNNOW_WEBHOOK_URL", "");
    const calls: Array<{ url: string; body: any }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => {
      calls.push({ url: String(url), body: init?.body && typeof init.body === "string" ? JSON.parse(init.body) : null });
      return new Response(JSON.stringify({ id: "sub" }), { status: 200 });
    }));
    const { subscribeEntityEvents } = await import("../signnowClient.js");
    expect(await subscribeEntityEvents("document", "doc123")).toBe(2);
    expect(calls.map((c) => c.body.event)).toEqual(["document.complete", "document.fieldinvite.signed"]);
    expect(calls[0]!.url).toMatch(/\/api\/v2\/events$/);
    expect(calls[0]!.body).toMatchObject({ entity_id: "doc123", action: "callback", attributes: { callback: "https://kt1.api.keystonecrm.online/api/webhooks/signnow", secret_key: "s" } });
    vi.unstubAllGlobals();
  });

  it("does nothing outside shared hosting", async () => {
    vi.doMock("../../tenancy/mode.js", async (orig) => ({ ...(await orig<any>()), isMultiBrokerage: () => false }));
    const f = vi.fn(); vi.stubGlobal("fetch", f);
    const { subscribeEntityEvents } = await import("../signnowClient.js");
    expect(await subscribeEntityEvents("document_group", "g1")).toBe(0);
    expect(f).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
