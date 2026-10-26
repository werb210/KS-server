// KS_SETTINGS_PACK_v1_TIME_ZONE - the brokerage's time zone drives local time everywhere, with correct DST.
import { afterEach, describe, expect, it } from "vitest";
import {
  brokerageTimeZone, brokerageZoneName, computeZoneAt, isValidTimeZone, sqlZoneLiteral, zoneLabel, zonedDay, zonedParts, zonedTime,
} from "../brokerageTime.js";
import { resetLastLoadedLicensee } from "../../licensee/settings.js";
import { checkField } from "../../licensee/settings.js";
import { nextAllowedSendTime } from "../../modules/automation/conditions.js";
import { businessHoursSql } from "../../modules/presence/presenceService.js";
import { candidateSlots } from "../../services/clientBooking.js";
import { mondayWindow } from "../../services/adsWeeklyEmail.js";
import { periodOf } from "../../plans/usage.js";
import { isWithinCallHours, defaultCallHours } from "../../voice/callHours.js";
import { inviteText } from "../../services/meetingRooms.js";

function useZone(tz: string | undefined) {
  resetLastLoadedLicensee();
  if (tz === undefined) delete process.env.KS_TIME_ZONE; else process.env.KS_TIME_ZONE = tz;
}
afterEach(() => useZone(undefined));

describe("brokerage time zone", () => {
  it("defaults to America/Edmonton, computed as UTC-6 all year", () => {
    useZone(undefined);
    expect(brokerageZoneName()).toBe("America/Edmonton");
    expect(brokerageTimeZone()).toBe("America/Regina");
    expect(zonedTime(2026, 12, 7, 9).toISOString()).toBe("2026-12-07T15:00:00.000Z");
    expect(zonedTime(2026, 7, 7, 9).toISOString()).toBe("2026-07-07T15:00:00.000Z");
    expect(zoneLabel()).toBe("Alberta time");
  });

  it("follows Toronto's daylight saving changes on the right dates", () => {
    useZone("America/Toronto");
    expect(brokerageTimeZone()).toBe("America/Toronto");
    // 2026: EDT from 8 March, EST from 1 November.
    expect(zonedTime(2026, 3, 6, 9).toISOString()).toBe("2026-03-06T14:00:00.000Z");
    expect(zonedTime(2026, 3, 9, 9).toISOString()).toBe("2026-03-09T13:00:00.000Z");
    expect(zonedTime(2026, 10, 30, 9).toISOString()).toBe("2026-10-30T13:00:00.000Z");
    expect(zonedTime(2026, 11, 2, 9).toISOString()).toBe("2026-11-02T14:00:00.000Z");
    // The skipped hour (02:30 on 8 March) lands an hour later rather than failing.
    expect(zonedParts(zonedTime(2026, 3, 8, 2, 30)).hour).toBe(3);
    expect(zonedDay(new Date("2026-11-01T03:30:00Z"))).toBe("2026-10-31");
    expect(zoneLabel()).toBe("Toronto time");
  });

  it("an invalid stored zone falls back to Edmonton, and the Company setting refuses one", () => {
    useZone("Mars/Olympus");
    expect(brokerageZoneName()).toBe("America/Edmonton");
    expect(isValidTimeZone("America/Vancouver")).toBe(true);
    expect(isValidTimeZone("x'; DROP TABLE users; --")).toBe(false);
    expect(checkField("time_zone", "Mars/Olympus").ok).toBe(false);
    expect(checkField("time_zone", "America/Halifax")).toEqual({ ok: true, value: "America/Halifax" });
  });

  it("only ever inlines a validated zone into SQL", () => {
    expect(sqlZoneLiteral("x'; DROP TABLE users; --")).toBe("'America/Regina'");
    useZone("America/Toronto"); // KS_SERVER_PERMANENT_TIME_v1 - Vancouver is now computed as Etc/GMT+7
    expect(businessHoursSql()).toContain("AT TIME ZONE 'America/Toronto'");
    expect(businessHoursSql()).not.toContain("Regina");
  });

  it("keeps Edmonton's old rules for history before Alberta stopped changing clocks", () => {
    expect(computeZoneAt("America/Edmonton", new Date("2025-11-03T14:05:00Z"))).toBe("America/Edmonton");
    expect(computeZoneAt("America/Edmonton", new Date("2026-11-03T14:05:00Z"))).toBe("America/Regina");
  });

  it("quiet hours, booking slots, the Monday email and usage periods use the brokerage's zone", () => {
    useZone("America/Toronto");
    // 08:30 Toronto (EDT) is before 09:00: next send at 09:00 Toronto = 13:00Z.
    expect(nextAllowedSendTime(new Date("2026-07-15T12:30:00Z"))?.toISOString()).toBe("2026-07-15T13:00:00.000Z");
    const slots = candidateSlots(new Date("2026-07-13T00:00:00Z"), 1);
    expect(slots[0]?.toISOString()).toBe("2026-07-13T13:00:00.000Z"); // Monday 09:00 EDT
    expect(mondayWindow(new Date("2026-07-13T12:30:00Z"))).toBe("2026-07-13"); // 08:30 Toronto
    expect(mondayWindow(new Date("2026-07-13T11:30:00Z"))).toBeNull(); // 07:30 Toronto
    expect(periodOf(new Date("2026-08-01T03:00:00Z"))).toBe("2026-07"); // still 31 July in Toronto
    expect(defaultCallHours().timezone).toBe("America/Toronto");
    const text = inviteText({ title: "T", code: "123456", slug: "s", starts_at: "2026-12-07T15:00:00Z" });
    expect(text).toContain("10:00");
    expect(text).toContain("(Toronto time)");
  });

  it("call hours in Edmonton stay UTC-6 through the winter of 2026", () => {
    useZone(undefined);
    const weekly = { sun: [], mon: [["08:00", "18:00"]], tue: [], wed: [], thu: [], fri: [], sat: [] } as any;
    // Monday 7 December 2026, 08:05 Alberta (UTC-6) = 14:05Z.
    expect(isWithinCallHours({ enabled: true, timezone: "America/Edmonton", weekly }, new Date("2026-12-07T14:05:00Z"))).toBe(true);
    expect(isWithinCallHours({ enabled: true, timezone: "America/Edmonton", weekly }, new Date("2026-12-07T13:55:00Z"))).toBe(false);
  });
});

// KS_SERVER_PERMANENT_TIME_v1 - Alberta, Manitoba and B.C. no longer fall back on 2026-11-01.
import { computeZone as kspCompute, computeZoneAt as kspAt, zonedParts as kspParts } from "../brokerageTime.js";
describe("provinces on permanent time (2026)", () => {
  const winter = new Date("2026-12-15T18:00:00Z");
  it("Edmonton is UTC-6, Winnipeg UTC-5 and Vancouver UTC-7 in winter", () => {
    expect(kspParts(winter, kspCompute("America/Edmonton")).hour).toBe(12);
    expect(kspParts(winter, kspCompute("America/Winnipeg")).hour).toBe(13);
    expect(kspParts(winter, kspCompute("America/Vancouver")).hour).toBe(11);
  });
  it("Toronto still falls back (UTC-5 in winter)", () => {
    expect(kspParts(winter, kspCompute("America/Toronto")).hour).toBe(13);
    expect(kspParts(new Date("2026-07-15T18:00:00Z"), kspCompute("America/Toronto")).hour).toBe(14);
  });
  it("history before 2026-03-08 keeps the old rules", () => {
    expect(kspAt("America/Winnipeg", new Date("2025-12-15T18:00:00Z"))).toBe("America/Winnipeg");
    expect(kspAt("America/Vancouver", new Date("2026-12-15T18:00:00Z"))).toBe("Etc/GMT+7");
  });
});
