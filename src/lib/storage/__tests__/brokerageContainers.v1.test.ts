// KS_SERVER_BROKERAGE_CONTAINERS_v1
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => { vi.resetModules(); vi.unstubAllEnvs(); vi.doUnmock("../../../tenancy/mode.js"); vi.doUnmock("../../../tenancy/context.js"); });

async function load(multi: boolean, code: string | null) {
  vi.doMock("../../../tenancy/mode.js", () => ({ isMultiBrokerage: () => multi, sharedEnv: () => process.env }));
  vi.doMock("../../../tenancy/context.js", () => ({ currentTenantCode: () => code }));
  return import("../containers.js");
}

describe("brokerageContainer", () => {
  it("keeps the exact name on a single-brokerage server", async () => {
    const m = await load(false, "kt1");
    expect(m.brokerageContainer("bf-documents", "documents")).toBe("bf-documents");
  });
  it("prefixes the brokerage code on the shared server", async () => {
    const m = await load(true, "kt1");
    expect(m.brokerageContainer("bf-documents", "documents")).toBe("kt1-documents");
    expect(m.brokerageContainer("voicemails")).toBe("kt1-voicemails");
  });
  it("keeps the base name outside any brokerage", async () => {
    const m = await load(true, null);
    expect(m.brokerageContainer("mms-inbound")).toBe("mms-inbound");
  });
  it("makes names Azure accepts", async () => {
    const m = await load(true, "KT_9");
    expect(m.brokerageContainer("signed-applications")).toBe("kt-9-signed-applications");
    expect(m.safeContainerName("A")).toBe("ks-a");
    expect(m.safeContainerName("x".repeat(80)).length).toBe(63);
  });
});

describe("purgeContainers on the shared server", () => {
  it("names only this brokerage's containers", async () => {
    vi.doMock("../../../tenancy/mode.js", () => ({ isMultiBrokerage: () => true, sharedEnv: () => process.env }));
    vi.doMock("../../../tenancy/context.js", () => ({ currentTenantCode: () => "kt2", currentTenant: () => undefined, requireTenant: () => ({}), tenantKey: (k: string) => k, runWithTenant: (_c: unknown, f: () => unknown) => f(), tenantLocal: (i: () => unknown) => ({ value: i(), reset() {}, resetAll() {}, all: () => [] }) }));
    const { purgeContainers } = await import("../../../plans/purge.js");
    expect(purgeContainers({} as NodeJS.ProcessEnv)).toEqual(["kt2-documents", "kt2-voicemails", "kt2-signed-applications", "kt2-mms-inbound", "kt2-marketing-assets"]);
  });
});
