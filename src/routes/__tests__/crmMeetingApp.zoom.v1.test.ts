// KS_ZOOM_MEETINGS_v1 - the CRM meeting form's Zoom / Google Meet / Teams choice.
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const h = vi.hoisted(() => ({ q: vi.fn(), graph: null as any, google: null as any, zoomOn: false, createZoom: vi.fn(), createGoogle: vi.fn() }));
vi.mock("../../db.js", () => ({ pool: { query: (s: string, p?: unknown[]) => h.q(s, p) } }));
vi.mock("../../modules/o365/graphClient.js", () => ({ getGraphForUser: vi.fn(async () => h.graph) }));
vi.mock("../../services/workspace/googleAuth.js", () => ({ getGoogleForUser: vi.fn(async () => h.google) }));
vi.mock("../../services/workspace/google.js", () => ({ createGoogleEvent: (...a: unknown[]) => h.createGoogle(...a) }));
vi.mock("../../services/teams/autoRecord.js", () => ({ enableAutoRecording: vi.fn() }));
vi.mock("../../services/meetings/meetingApps.js", async () => {
  const real = await vi.importActual<any>("../../services/meetings/meetingApps.js");
  return { ...real, zoomConnected: vi.fn(async () => h.zoomOn), zoomClientFor: vi.fn(async () => (h.zoomOn ? { userId: "u" } : null)) };
});
vi.mock("../../meetingNotes/zoom.js", async () => {
  const real = await vi.importActual<any>("../../meetingNotes/zoom.js");
  return { ...real, createZoomMeeting: (...a: unknown[]) => h.createZoom(...a) };
});

import meetings from "../crm/meetings.js";

const USER = "11111111-1111-4111-8111-111111111111";
const CONTACT = "22222222-2222-4222-8222-222222222222";
function app() {
  const a = express();
  a.use(express.json());
  a.use((req: any, _res, next) => { req.user = { id: USER }; next(); });
  a.use("/api/crm/contacts/:id/meetings", meetings);
  return a;
}
const body = (extra: Record<string, unknown> = {}) => ({ title: "Review", start_at: "2026-11-10T16:00:00.000Z", end_at: "2026-11-10T16:30:00.000Z", meeting_type: "teams", online: true, attendees: [{ address: "client@example.test" }], ...extra });

beforeEach(() => {
  h.graph = null; h.google = null; h.zoomOn = false;
  h.createZoom.mockReset().mockResolvedValue({ id: "99", joinUrl: "https://zoom.us/j/99" });
  h.createGoogle.mockReset().mockResolvedValue({ id: "g1", joinUrl: "https://meet.google.com/abc" });
  h.q.mockReset().mockImplementation(async (sql: string, p?: unknown[]) =>
    /INSERT INTO crm_meetings/.test(sql) ? { rows: [{ id: "m1", location: p?.[5] }] } : { rows: [] });
});

describe("CRM meeting app", () => {
  it("Zoom: makes the Zoom meeting and puts its link on the Outlook event, with no Teams meeting", async () => {
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ id: "ev1" }), text: async () => "" }));
    h.graph = { fetch }; h.zoomOn = true;
    const r = await request(app()).post(`/api/crm/contacts/${CONTACT}/meetings`).send(body({ meeting_app: "zoom" }));
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ meeting_app: "zoom", location: "https://zoom.us/j/99" });
    const ev = JSON.parse((fetch.mock.calls[0] as any)[1].body);
    expect(ev.isOnlineMeeting).toBeUndefined();
    expect(ev.location).toMatchObject({ displayName: "Zoom", locationUri: "https://zoom.us/j/99" });
    expect(ev.body.content).toContain("https://zoom.us/j/99");
    expect(h.q.mock.calls.some(([s]) => /INSERT INTO teams_meetings/.test(String(s)))).toBe(false);
  });

  it("Google Meet chosen by a broker with both Microsoft and Google: Google Calendar with Meet, not Outlook", async () => {
    const fetch = vi.fn(); h.graph = { fetch }; h.google = { userId: USER };
    const r = await request(app()).post(`/api/crm/contacts/${CONTACT}/meetings`).send(body({ meeting_app: "google_meet" }));
    expect(r.status).toBe(201);
    expect(fetch).not.toHaveBeenCalled();
    expect((h.createGoogle.mock.calls[0] as any)[1]).toMatchObject({ meet: true });
    expect(r.body.data.meeting_app).toBe("google_meet");
  });

  it("refuses an app that is not connected", async () => {
    h.graph = { fetch: vi.fn() };
    const r = await request(app()).post(`/api/crm/contacts/${CONTACT}/meetings`).send(body({ meeting_app: "zoom" }));
    expect(r.status).toBe(412);
    expect(r.body.error).toBe("zoom_not_connected");
  });

  it("no choice: a Microsoft 365 broker still gets Teams", async () => {
    const fetch = vi.fn(async (path: string) => path.startsWith("/me?")
      ? { ok: true, json: async () => ({ userPrincipalName: "me@broker.test" }) }
      : { ok: true, json: async () => ({ id: "ev2", onlineMeeting: { joinUrl: "https://teams.microsoft.com/l/x" } }), text: async () => "" });
    h.graph = { fetch }; h.zoomOn = true;
    const r = await request(app()).post(`/api/crm/contacts/${CONTACT}/meetings`).send(body());
    expect(r.body.data.meeting_app).toBe("teams");
    expect(JSON.parse((fetch.mock.calls[0] as any)[1].body).isOnlineMeeting).toBe(true);
    expect(h.createZoom).not.toHaveBeenCalled();
  });
});
