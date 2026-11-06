// KS_ZOOM_MEETINGS_v1 - Keystone's shared Zoom app, Zoom meeting creation and the meeting-app choice.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createZoomMeeting, zoomConfig, zoomConfigProblem, zoomCryptoEnv, type ZoomClient } from "../zoom.js";
import { pickMeetingApp } from "../../services/meetings/meetingApps.js";
import { unwrapState, wrapState } from "../../licensee/oauthBroker.js";

const BROKER = { KS_OAUTH_BROKER_URL: "https://ops.keystonecrm.online/api/oauth/callback", KS_LICENSEE_ID: "11111111-2222-4333-8444-555555555555", KS_OPS_KEY: "ops-key-test" };

describe("Keystone Zoom app", () => {
  it("uses KS_ZOOM_* with the broker redirect, and a JWT-derived token key when none is set", () => {
    const e = { ...BROKER, KS_ZOOM_CLIENT_ID: "kz", KS_ZOOM_CLIENT_SECRET: "ks", JWT_SECRET: "jwt-test-secret" } as NodeJS.ProcessEnv;
    expect(zoomConfigProblem(e)).toBeNull();
    expect(zoomConfig(e)).toMatchObject({ clientId: "kz", clientSecret: "ks", redirectUri: "https://ops.keystonecrm.online/api/oauth/callback/zoom" });
    expect(zoomCryptoEnv(e).ZOOM_TOKEN_ENCRYPTION_KEY).toBe("zoom-tokens:jwt-test-secret");
  });

  it("a brokerage's own Zoom app still wins", () => {
    const e = { ZOOM_CLIENT_ID: "own", ZOOM_CLIENT_SECRET: "own-s", KS_ZOOM_CLIENT_ID: "kz", KS_ZOOM_CLIENT_SECRET: "ks", ZOOM_TOKEN_ENCRYPTION_KEY: "k" } as NodeJS.ProcessEnv;
    expect(zoomConfig(e)).toMatchObject({ clientId: "own", clientSecret: "own-s" });
    expect(zoomCryptoEnv(e)).toBe(e);
  });

  it("the connect state round-trips through the broker for the zoom flow only", () => {
    const e = BROKER as NodeJS.ProcessEnv;
    const wrapped = wrapState("zoom", "inner_state", 60_000, e);
    expect(wrapped.startsWith("ks1.")).toBe(true);
    expect(unwrapState("zoom", wrapped, e)).toBe("inner_state");
    expect(unwrapState("qbo", wrapped, e)).toBeNull();
  });
});

describe("creating a Zoom meeting", () => {
  it("posts a scheduled meeting with cloud recording and returns the join link", async () => {
    const post = vi.fn(async () => ({ id: 987654321, join_url: "https://zoom.us/j/987654321" }));
    const z = { userId: "u", token: () => "t", get: vi.fn(), download: vi.fn(), post } as unknown as ZoomClient;
    const m = await createZoomMeeting(z, { topic: "Review", start: "2026-11-10T16:00:00.000Z", end: "2026-11-10T16:45:00.000Z" });
    expect(m).toEqual({ id: "987654321", joinUrl: "https://zoom.us/j/987654321" });
    const [path, body] = post.mock.calls[0] as unknown as [string, any];
    expect(path).toBe("/users/me/meetings");
    expect(body).toMatchObject({ type: 2, duration: 45, start_time: "2026-11-10T16:00:00Z", settings: { auto_recording: "cloud" } });
  });
});

describe("which meeting app", () => {
  const all = { teams: true, google_meet: true, zoom: true };
  it("defaults to what is connected: Teams, then Meet, then Zoom", () => {
    expect(pickMeetingApp(all)).toBe("teams");
    expect(pickMeetingApp({ teams: false, google_meet: true, zoom: true })).toBe("google_meet");
    expect(pickMeetingApp({ teams: false, google_meet: false, zoom: true })).toBe("zoom");
    expect(pickMeetingApp({ teams: false, google_meet: false, zoom: false })).toBeNull();
  });
  it("honours a choice only when that app is connected", () => {
    expect(pickMeetingApp(all, "zoom")).toBe("zoom");
    expect(pickMeetingApp({ teams: true, google_meet: false, zoom: false }, "google_meet")).toBeNull();
  });
});
