// KS_HUBSPOT_GAPS_1_MEETING_NOTES - Zoom and Google Meet meeting notes (every plan with office sync).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "../../__tests__/helpers/answerBySql.js";

const g = vi.hoisted(() => ({ client: null as any }));
vi.mock("../../services/workspace/googleAuth.js", async () => {
  const actual = await vi.importActual<any>("../../services/workspace/googleAuth.js");
  return { ...actual, getGoogleForUser: vi.fn(async () => g.client) };
});

import { requestedScopes, SCOPE_MEET_READONLY } from "../../services/workspace/googleConfig.js";
import { planIncludes } from "../../plans/catalogue.js";
import { zoomAuthorizeUrl, zoomConfigProblem, zoomTranscriptMeetings, zoomUuidPath, type ZoomClient } from "../zoom.js";
import { meetTranscriptText } from "../googleMeet.js";
import { importMeeting, syncGoogleMeetUser } from "../sync.js";

const USER = "11111111-1111-4111-8111-111111111111";
afterEach(() => { g.client = null; });

function googleClient(routes: Record<string, unknown>, scopes = [SCOPE_MEET_READONLY]) {
  return {
    provider: "google", userId: USER, email: "me@broker.test", scopes, accessToken: "t",
    fetch: vi.fn(async (url: string) => {
      const key = Object.keys(routes).find((k) => url.includes(k));
      return new Response(JSON.stringify(key ? routes[key] : {}), { status: key ? 200 : 404 });
    }),
  };
}

describe("set-up", () => {
  it("is on every plan with office sync", () => {
    expect(planIncludes("starter", "office_sync")).toBe(true);
  });

  it("names the missing Zoom settings and sends people to Zoom's consent screen", () => {
    expect(zoomConfigProblem({})).toContain("ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET, ZOOM_TOKEN_ENCRYPTION_KEY");
    const u = new URL(zoomAuthorizeUrl({ clientId: "zc", clientSecret: "zs", redirectUri: "https://s.example/api/meeting-notes/zoom/callback" }, "st"));
    expect(u.origin + u.pathname).toBe("https://zoom.us/oauth/authorize");
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ response_type: "code", client_id: "zc", state: "st" });
  });

  it("asks Google for Meet access only when switched on", () => {
    expect(requestedScopes({} as any)).not.toContain(SCOPE_MEET_READONLY);
    expect(requestedScopes({ GOOGLE_MEET_NOTES_ENABLED: "true" } as any)).toContain(SCOPE_MEET_READONLY);
  });
});

describe("Zoom", () => {
  it("encodes meeting UUIDs that start with a slash twice", () => {
    expect(zoomUuidPath("abc==")).toBe("abc%3D%3D");
    expect(zoomUuidPath("/ab//c")).toBe(encodeURIComponent(encodeURIComponent("/ab//c")));
  });

  it("lists only meetings with a finished transcript, across pages", async () => {
    const pages: Record<string, any> = {
      first: { next_page_token: "p2", meetings: [
        { uuid: "u1", id: 1, topic: "Acme call", start_time: "2026-10-20T15:00:00Z", duration: 30, share_url: "https://zoom.us/rec/share/1",
          recording_files: [{ file_type: "MP4", download_url: "x" }, { file_type: "TRANSCRIPT", status: "completed", download_url: "https://zoom.us/rec/download/t1" }] },
        { uuid: "u2", id: 2, topic: "No transcript", start_time: "2026-10-20T16:00:00Z", duration: 10, recording_files: [{ file_type: "MP4", download_url: "y" }] },
      ] },
      p2: { next_page_token: "", meetings: [{ uuid: "u3", id: 3, topic: "Still processing", start_time: "2026-10-21T15:00:00Z", duration: 5, recording_files: [{ file_type: "TRANSCRIPT", status: "processing", download_url: "z" }] }] },
    };
    const z: ZoomClient = { userId: USER, token: () => "t", download: vi.fn(), get: vi.fn(async (path: string) => (path.includes("next_page_token=p2") ? pages.p2 : pages.first)) as any };
    const out = await zoomTranscriptMeetings(z, new Date("2026-10-12"), new Date("2026-10-26"));
    expect(out).toEqual([{ uuid: "u1", id: "1", topic: "Acme call", start: new Date("2026-10-20T15:00:00Z"), end: new Date("2026-10-20T15:30:00Z"), transcriptUrl: "https://zoom.us/rec/download/t1", shareUrl: "https://zoom.us/rec/share/1" }]);
    expect((z.get as any).mock.calls[0][0]).toContain("from=2026-10-12&to=2026-10-26");
  });
});

describe("Google Meet", () => {
  it("builds a speaker-attributed transcript from the Meet API", async () => {
    const c = googleClient({
      "conferenceRecords/r1/transcripts/t1/entries": { transcriptEntries: [{ participant: "conferenceRecords/r1/participants/p1", text: "Hi Pat" }, { participant: "conferenceRecords/r1/participants/p2", text: "Hello" }] },
      "conferenceRecords/r1/transcripts": { transcripts: [{ name: "conferenceRecords/r1/transcripts/t1", state: "FILE_GENERATED", docsDestination: { exportUri: "https://docs.google.com/document/d/x/export" } }] },
      "conferenceRecords/r1/participants": { participants: [{ name: "conferenceRecords/r1/participants/p1", signedinUser: { displayName: "Sam Broker" } }, { name: "conferenceRecords/r1/participants/p2", anonymousUser: { displayName: "Pat" } }] },
    });
    expect(await meetTranscriptText(c as any, "conferenceRecords/r1")).toEqual({ text: "Sam Broker: Hi Pat\nPat: Hello", docUrl: "https://docs.google.com/document/d/x/export" });
  });

  it("imports a finished Meet, matched to a contact from the calendar event's guests", async () => {
    g.client = googleClient({
      "/v2/conferenceRecords?": { conferenceRecords: [{ name: "conferenceRecords/r1", startTime: "2026-10-25T15:00:00Z", endTime: "2026-10-25T15:40:00Z", space: "spaces/s1" }] },
      "/v2/spaces/s1": { meetingCode: "abc-defg-hij" },
      "conferenceRecords/r1/transcripts/t1/entries": { transcriptEntries: [{ participant: "p1", text: "Let's talk about the loan" }] },
      "conferenceRecords/r1/transcripts": { transcripts: [{ name: "conferenceRecords/r1/transcripts/t1", state: "FILE_GENERATED" }] },
      "conferenceRecords/r1/participants": { participants: [] },
      "calendar/v3/calendars/primary/events": { items: [{ id: "e1", summary: "Acme - next steps", hangoutLink: "https://meet.google.com/abc-defg-hij", attendees: [{ email: "me@broker.test" }, { email: "Pat@Acme.test" }], start: { dateTime: "2026-10-25T15:00:00Z" }, end: { dateTime: "2026-10-25T15:45:00Z" } }] },
    });
    const q = vi.fn(answerBySql([
      [/FROM contacts c\s+WHERE c.merged_into_id IS NULL/, (_s: string, p?: unknown[]) => ({ rows: (p?.[0] as string[]).includes("pat@acme.test") ? [{ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", company_id: null }] : [] })],
      [/INSERT INTO teams_meetings/, { rows: [{ id: "m1" }] }],
    ]));
    expect(await syncGoogleMeetUser({ query: q }, USER, new Date("2026-10-26T00:00:00Z"))).toBe(1);
    const [, p] = callsMatching(q, /INSERT INTO teams_meetings/)[0]!;
    expect((p as unknown[]).slice(0, 4)).toEqual(["google_meet", "conferenceRecords/r1", USER, "Acme - next steps"]);
    expect((p as unknown[])[6]).toBe("Speaker: Let's talk about the loan");
    expect((p as unknown[])[8]).toBe("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
    expect(callsMatching(q, /INSERT INTO google_meet_sync/)).toHaveLength(1);
  });

  it("does nothing until the person has given Meet access", async () => {
    g.client = googleClient({}, []);
    const q = vi.fn(answerBySql([]));
    expect(await syncGoogleMeetUser({ query: q }, USER)).toBe(0);
    expect(q).not.toHaveBeenCalled();
  });
});

describe("filing a meeting", () => {
  beforeEach(() => vi.restoreAllMocks());
  it("keeps a meeting without a matching contact so its owner can file it", async () => {
    const q = vi.fn(answerBySql([[/INSERT INTO teams_meetings/, { rows: [{ id: "m2" }] }]]));
    expect(await importMeeting({ query: q }, { provider: "zoom", externalId: "u9", userId: USER, subject: "Call", start: new Date(), end: new Date(), transcript: "WEBVTT", recordingUrl: null, emails: [] })).toBe("m2");
    const [sql, p] = callsMatching(q, /INSERT INTO teams_meetings/)[0]!;
    expect(String(sql)).toContain("ON CONFLICT (provider, external_id) WHERE external_id IS NOT NULL DO NOTHING");
    expect((p as unknown[])[8]).toBeNull();
  });
});
