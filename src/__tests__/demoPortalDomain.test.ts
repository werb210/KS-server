// The demo portal is moving from its Azure address to demo.keystonecrm.online. The demo copy accepts both; a
// brokerage with its own portal address accepts only its own.
import { afterEach, describe, expect, it } from "vitest";
import { DEMO_PORTAL_DOMAIN, portalAliases, portalUrl } from "../licensee/urls.js";

const saved = { ...process.env };
afterEach(() => { process.env = { ...saved }; });

describe("the demo portal's addresses", () => {
  it("the demo copy accepts the Keystone address as well as the development one", () => {
    delete process.env.KS_PORTAL_URL; delete process.env.PORTAL_URL;
    expect(portalAliases()).toEqual([DEMO_PORTAL_DOMAIN]);
    process.env.KS_PORTAL_URL = DEMO_PORTAL_DOMAIN;
    expect(portalUrl()).toBe(DEMO_PORTAL_DOMAIN);
    expect(portalAliases()).toHaveLength(1);
    expect(portalAliases()[0]).toMatch(/azurestaticapps\.net$/);
  });
  it("a brokerage's own portal has no extra addresses", () => {
    process.env.KS_PORTAL_URL = "https://abc.portal.keystonecrm.online";
    expect(portalAliases()).toEqual([]);
  });
});
